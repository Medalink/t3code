/**
 * UsageLimitHistory: every quota window the server sees, kept for the Limits
 * history chart and forecast.
 *
 * One writer fiber records from the provider registry and the hub sources,
 * upstream of the debounce `subscribeServerConfig` applies, and adds no
 * probes of its own. Readings are stored when their content changes or an
 * hour has passed, and pruned after the retention window.
 *
 * @module usage/UsageLimitHistory
 */
import {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  USAGE_LIMIT_HISTORY_RETENTION_DAYS,
  type UsageLimitHistory as UsageLimitHistoryResult,
  UsageLimitHistoryError,
  type UsageLimitHistoryInput,
  UsageLimitHistorySubject,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import {
  encodeSubject,
  observeProviders,
  observeSources,
  seriesKey,
  shouldRecord,
  toHistoryPeriods,
  type UsageLimitObservation,
  type UsageLimitReading,
} from "./usageLimitSamples.ts";

export class UsageLimitHistory extends Context.Service<
  UsageLimitHistory,
  {
    /** Stored readings since `input.sinceMs`, grouped by series and period. */
    readonly read: (
      input: UsageLimitHistoryInput,
    ) => Effect.Effect<UsageLimitHistoryResult, UsageLimitHistoryError>;
  }
>()("t3/usage/UsageLimitHistory") {}

const RETENTION_MS = USAGE_LIMIT_HISTORY_RETENTION_DAYS * 24 * 60 * 60_000;
const MAX_POINTS_PER_SERIES = 600;

const SampleRow = Schema.Struct({
  seriesId: Schema.Number,
  subject: Schema.fromJsonString(UsageLimitHistorySubject),
  driver: ProviderDriverKind,
  email: Schema.String,
  workspaceId: Schema.String,
  credentialFingerprint: Schema.String,
  windowKind: ServerProviderUsageWindow.fields.kind,
  windowId: Schema.String,
  sampledAt: Schema.Number,
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.Number),
});
type SampleRow = typeof SampleRow.Type;

const SELECT_SAMPLES = `
    SELECT
      s.series_id AS "seriesId", s.subject, s.driver, s.email,
      s.workspace_id AS "workspaceId", s.credential_fingerprint AS "credentialFingerprint",
      s.window_kind AS "windowKind", s.window_id AS "windowId",
      m.sampled_at AS "sampledAt", m.used_percent AS "usedPercent", m.resets_at AS "resetsAt"
    FROM usage_limit_series s
    JOIN usage_limit_samples m ON m.series_id = s.series_id
`;

/** Deletes readings past retention and the series they leave empty. */
export const pruneUsageLimitHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM usage_limit_samples WHERE sampled_at < ${cutoff}`;
      yield* sql`
        DELETE FROM usage_limit_series
        WHERE NOT EXISTS (
          SELECT 1 FROM usage_limit_samples
          WHERE usage_limit_samples.series_id = usage_limit_series.series_id
        )
      `;
    }),
  );
});

/**
 * The single writer. Consumes observation batches in order and writes each
 * batch's news in one transaction. `last` holds the newest stored reading per
 * series, seeded from sqlite so a restart does not rewrite what is stored, and
 * only this fiber touches it. Tests feed `batches` directly.
 */
export const makeRecorder = (
  batches: Stream.Stream<ReadonlyArray<UsageLimitObservation>>,
): Effect.Effect<void, never, SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const findLatest = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SampleRow,
      execute: () => sql`
        ${sql.literal(SELECT_SAMPLES)}
        WHERE m.sampled_at = (
          SELECT MAX(sampled_at) FROM usage_limit_samples WHERE series_id = s.series_id
        )
      `,
    });
    // Starting empty only costs a few rewritten rows; every write is an upsert.
    const latest = yield* findLatest(undefined).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not load the latest usage limit samples", cause).pipe(
          Effect.as([] as ReadonlyArray<SampleRow>),
        ),
      ),
    );
    const last = new Map<string, UsageLimitReading>(latest.map((row) => [seriesKey(row), row]));

    const write = (observation: UsageLimitObservation) =>
      sql<{ readonly seriesId: number }>`
        INSERT INTO usage_limit_series (
          subject, driver, email, workspace_id, credential_fingerprint, window_kind, window_id
        ) VALUES (
          ${encodeSubject(observation.subject)}, ${observation.driver}, ${observation.email},
          ${observation.workspaceId}, ${observation.credentialFingerprint},
          ${observation.windowKind}, ${observation.windowId}
        )
        ON CONFLICT (
          subject, driver, email, workspace_id, credential_fingerprint, window_kind, window_id
        ) DO UPDATE SET window_id = excluded.window_id
        RETURNING series_id AS "seriesId"
      `.pipe(
        Effect.flatMap(
          ([series]) =>
            sql`
              INSERT INTO usage_limit_samples (series_id, sampled_at, used_percent, resets_at)
              VALUES (
                ${series!.seriesId}, ${observation.sampledAt}, ${observation.usedPercent},
                ${observation.resetsAt}
              )
              ON CONFLICT (series_id, sampled_at) DO UPDATE SET
                used_percent = excluded.used_percent,
                resets_at = excluded.resets_at
            `,
        ),
      );

    const record = (batch: ReadonlyArray<UsageLimitObservation>) => {
      const news = new Map<string, UsageLimitObservation>();
      for (const observation of batch) {
        const key = seriesKey(observation);
        if (shouldRecord(news.get(key) ?? last.get(key), observation)) news.set(key, observation);
      }
      if (news.size === 0) return Effect.void;
      // `last` moves only after the commit, so a rolled-back batch is retried
      // on the next emission instead of being skipped as already stored.
      return sql.withTransaction(Effect.forEach(news.values(), write, { discard: true })).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const [key, observation] of news) last.set(key, observation);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record usage limit samples", cause).pipe(
            Effect.annotateLogs({ samples: news.size }),
          ),
        ),
      );
    };

    const prune = pruneUsageLimitHistory.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not prune usage limit history", cause)),
    );
    yield* prune;
    yield* forkParked(Stream.runForEach(batches, record));
    yield* forkParked(prune.pipe(Effect.delay("1 hour"), Effect.repeat(Schedule.spaced("1 hour"))));
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;

  yield* makeRecorder(
    Stream.merge(
      Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges).pipe(
        Stream.map(observeProviders),
      ),
      // Replays the current set before changes.
      sources.streamChanges.pipe(Stream.map(observeSources)),
    ),
  );

  // Rows since `since`, plus each series' last row before it, so a chart
  // starts at the left edge instead of at the first reading inside the range.
  const findSince = SqlSchema.findAll({
    Request: Schema.Struct({ since: Schema.Number }),
    Result: SampleRow,
    execute: ({ since }) => sql`
      ${sql.literal(SELECT_SAMPLES)}
      WHERE m.sampled_at >= ${since}
        OR m.sampled_at = (
          SELECT MAX(sampled_at) FROM usage_limit_samples
          WHERE series_id = s.series_id AND sampled_at < ${since}
        )
      ORDER BY s.series_id, m.sampled_at
    `,
  });

  const read = (input: UsageLimitHistoryInput) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const sinceMs = Math.max(input.sinceMs, nowMs - RETENTION_MS);
      const rows = yield* findSince({ since: sinceMs });
      const bySeries = new Map<number, SampleRow[]>();
      for (const row of rows) {
        const series = bySeries.get(row.seriesId);
        if (series) series.push(row);
        else bySeries.set(row.seriesId, [row]);
      }
      return {
        readAtMs: nowMs,
        retentionDays: USAGE_LIMIT_HISTORY_RETENTION_DAYS,
        series: [...bySeries.values()].map((samples) => {
          const { subject, driver, email, workspaceId, credentialFingerprint } = samples[0]!;
          return {
            subject,
            driver,
            ...(email ? { email } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            ...(credentialFingerprint ? { credentialFingerprint } : {}),
            windowId: samples[0]!.windowId,
            windowKind: samples[0]!.windowKind,
            periods: toHistoryPeriods(samples, {
              sinceMs,
              nowMs,
              requestedResolutionMs: input.resolutionMs,
              maxPoints: MAX_POINTS_PER_SERIES,
            }),
          };
        }),
      } satisfies UsageLimitHistoryResult;
    }).pipe(
      Effect.tapCause((cause) => Effect.logWarning("Could not read usage limit history", cause)),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? new UsageLimitHistoryError({ detail: "A stored quota sample could not be decoded." })
          : new UsageLimitHistoryError({ detail: "The quota history database could not be read." }),
      ),
    );

  return UsageLimitHistory.of({ read });
});

export const layer = Layer.effect(UsageLimitHistory, make);
