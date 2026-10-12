import {
  ProviderDriverKind,
  ProviderInstanceId,
  type UsageLimitHistoryInput,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitHistory from "./UsageLimitHistory.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import type { UsageLimitObservation } from "./usageLimitSamples.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const resetsAt = Date.parse("2026-09-03T14:00:00.000Z");

const observation = (overrides: Partial<UsageLimitObservation> = {}): UsageLimitObservation => ({
  subject: { _tag: "instance", instanceId: ProviderInstanceId.make("codex") },
  driver: ProviderDriverKind.make("codex"),
  email: "me@example.com",
  workspaceId: "",
  credentialFingerprint: "",
  windowKind: "session",
  windowId: "five_hour",
  sampledAt: now,
  usedPercent: 40,
  resetsAt,
  ...overrides,
});

/** Runs one recorder over `batches` and returns once it has handled the last one. */
const recordAll = (batches: ReadonlyArray<ReadonlyArray<UsageLimitObservation>>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handled = yield* Deferred.make<void>();
      yield* UsageLimitHistory.makeRecorder(
        Stream.concat(
          Stream.fromIterable(batches),
          Stream.fromEffect(Deferred.succeed(handled, undefined)).pipe(Stream.drain),
        ),
      );
      yield* Deferred.await(handled);
    }),
  );

const countRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [samples] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM usage_limit_samples`;
  const [series] = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS n FROM usage_limit_series`;
  return { samples: samples!.n, series: series!.n };
});

const layerHistory = UsageLimitHistory.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.succeed([]),
      streamChanges: Stream.empty,
    } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
  ),
  Layer.provide(
    Layer.succeed(UsageLimitSources.UsageLimitSources, {
      streamChanges: Stream.empty,
    } as unknown as UsageLimitSources.UsageLimitSources["Service"]),
  ),
);

/** Starts the service half an hour before `now`, so its startup prune keeps that half hour. */
const read = (input: UsageLimitHistoryInput) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now - 30 * MINUTE);
    const history = yield* Effect.provide(UsageLimitHistory.UsageLimitHistory, layerHistory);
    yield* TestClock.setTime(now);
    return yield* history.read(input);
  });

it.effect("ten identical readings with fresh checkedAt write one row", () =>
  Effect.gen(function* () {
    yield* recordAll(
      Array.from({ length: 10 }, (_, index) => [observation({ sampledAt: now + index * MINUTE })]),
    );
    assert.deepEqual(yield* countRows, { samples: 1, series: 1 });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an account switch on one instance starts a second series", () =>
  Effect.gen(function* () {
    yield* recordAll([
      [observation()],
      [observation({ sampledAt: now + MINUTE, email: "other@example.com" })],
    ]);
    assert.deepEqual(yield* countRows, { samples: 2, series: 2 });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a restarted recorder does not rewrite an unchanged reading", () =>
  Effect.gen(function* () {
    yield* recordAll([[observation()]]);
    yield* recordAll([[observation({ sampledAt: now + 5 * MINUTE })]]);
    assert.deepEqual(yield* countRows, { samples: 1, series: 1 });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a rolled-back batch is retried on the next emission and the recorder keeps going", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TRIGGER poison BEFORE INSERT ON usage_limit_samples
      WHEN NEW.used_percent = 99
      BEGIN SELECT RAISE(ABORT, 'poison'); END
    `;
    const hub = observation({
      subject: { _tag: "source", sourceId: UsageLimitSourceId.make("hub"), accountId: "a.json" },
    });
    yield* recordAll([
      [observation(), { ...hub, usedPercent: 99 }],
      [observation({ sampledAt: now + MINUTE }), { ...hub, sampledAt: now + MINUTE }],
    ]);
    const rows = yield* sql<{ readonly sampledAt: number; readonly subject: string }>`
      SELECT m.sampled_at AS "sampledAt", s.subject
      FROM usage_limit_samples m JOIN usage_limit_series s ON s.series_id = m.series_id
      ORDER BY s.subject`;
    assert.deepEqual(
      rows.map((row) => row.sampledAt),
      [now + MINUTE, now + MINUTE],
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("pruning drops readings past retention and the series they leave empty", () =>
  Effect.gen(function* () {
    const kept = observation();
    const expired = observation({ windowId: "seven_day", windowKind: "weekly" });
    yield* recordAll([
      [
        { ...kept, sampledAt: now - 40 * DAY },
        { ...expired, sampledAt: now - 40 * DAY },
      ],
      [{ ...kept, sampledAt: now - DAY }],
    ]);
    yield* TestClock.setTime(now);
    yield* UsageLimitHistory.pruneUsageLimitHistory;
    assert.deepEqual(yield* countRows, { samples: 1, series: 1 });
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("read starts each series at its last reading before since and splits on resets", () =>
  Effect.gen(function* () {
    const since = now - 10 * HOUR;
    const nextReset = resetsAt + 5 * HOUR;
    yield* recordAll([
      [observation({ sampledAt: since - 2 * HOUR, usedPercent: 5 })],
      [observation({ sampledAt: since - HOUR, usedPercent: 10 })],
      [observation({ sampledAt: since + HOUR, usedPercent: 30 })],
      [observation({ sampledAt: since + 2 * HOUR, usedPercent: 0, resetsAt: nextReset })],
      [
        observation({
          subject: {
            _tag: "source",
            sourceId: UsageLimitSourceId.make("hub"),
            accountId: "a.json",
          },
          email: "",
          credentialFingerprint: "fp",
          sampledAt: since + HOUR,
        }),
      ],
    ]);
    const history = yield* read({ sinceMs: since });
    assert.strictEqual(history.readAtMs, now);
    assert.strictEqual(history.retentionDays, 35);
    assert.deepEqual(history.series, [
      {
        subject: { _tag: "instance", instanceId: ProviderInstanceId.make("codex") },
        driver: ProviderDriverKind.make("codex"),
        email: "me@example.com",
        windowId: "five_hour",
        windowKind: "session",
        periods: [
          {
            resetsAtMs: resetsAt,
            points: [
              [since - HOUR, 10],
              [since + HOUR, 30],
            ],
          },
          { resetsAtMs: nextReset, points: [[since + 2 * HOUR, 0]] },
        ],
      },
      {
        subject: { _tag: "source", sourceId: UsageLimitSourceId.make("hub"), accountId: "a.json" },
        driver: ProviderDriverKind.make("codex"),
        credentialFingerprint: "fp",
        windowId: "five_hour",
        windowKind: "session",
        periods: [{ resetsAtMs: resetsAt, points: [[since + HOUR, 40]] }],
      },
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("read clamps since to retention and caps points per series", () =>
  Effect.gen(function* () {
    yield* recordAll([
      [observation({ sampledAt: now - 40 * DAY, resetsAt: null })],
      [observation({ sampledAt: now - 35 * DAY - 20 * MINUTE, resetsAt: null })],
      [observation({ sampledAt: now - 35 * DAY - 10 * MINUTE, usedPercent: 41, resetsAt: null })],
      // Hourly keepalives over 34 days: 816 stored rows.
      ...Array.from({ length: 816 }, (_, index) => [
        observation({ sampledAt: now - 34 * DAY + index * HOUR, resetsAt: null }),
      ]),
    ]);
    assert.strictEqual((yield* countRows).samples, 819);
    const history = yield* read({ sinceMs: 0 });
    const points = history.series.flatMap((series) =>
      series.periods.flatMap((period) => period.points),
    );
    assert.strictEqual(points[0]![0], now - 35 * DAY - 10 * MINUTE);
    assert.isAtMost(points.length, 600);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
