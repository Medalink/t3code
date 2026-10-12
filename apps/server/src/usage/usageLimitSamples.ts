import type {
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitHistoryPeriod,
  UsageLimitHistorySubject,
  UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import {
  limitsNotice,
  providersWithLimits,
  resetMillis,
  samePeriod,
} from "@t3tools/shared/usageLimits";

/** What a `usage_limit_series` row is unique on. Absent identity fields are "". */
export interface UsageLimitSeriesIdentity {
  readonly subject: UsageLimitHistorySubject;
  readonly driver: ProviderDriverKind;
  readonly email: string;
  readonly workspaceId: string;
  readonly credentialFingerprint: string;
  readonly windowKind: ServerProviderUsageWindow["kind"];
  readonly windowId: string;
}

export interface UsageLimitReading {
  readonly sampledAt: number;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
}

export interface UsageLimitObservation extends UsageLimitSeriesIdentity, UsageLimitReading {}

/**
 * The `subject` column. Keys are written in a fixed order so one reporter
 * always maps to one row under the UNIQUE constraint.
 */
export function encodeSubject(subject: UsageLimitHistorySubject): string {
  return subject._tag === "instance"
    ? JSON.stringify({ _tag: "instance", instanceId: subject.instanceId })
    : JSON.stringify({ _tag: "source", sourceId: subject.sourceId, accountId: subject.accountId });
}

/** Stable map key for a series; mirrors the table's UNIQUE constraint. */
export function seriesKey(identity: UsageLimitSeriesIdentity): string {
  return JSON.stringify([
    encodeSubject(identity.subject),
    identity.driver,
    identity.email,
    identity.workspaceId,
    identity.credentialFingerprint,
    identity.windowKind,
    identity.windowId,
  ]);
}

function observeLimits(
  identity: Omit<UsageLimitSeriesIdentity, "windowKind" | "windowId" | "credentialFingerprint">,
  limits: ServerProviderUsageLimits,
): UsageLimitObservation[] {
  // Same skip rule the Limits view applies, so history holds only what it can draw.
  if (limitsNotice(limits) !== null) return [];
  const sampledAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(sampledAt)) return [];
  return limits.windows.map((window) => ({
    ...identity,
    credentialFingerprint: limits.credentialFingerprint ?? "",
    windowKind: window.kind,
    windowId: window.id,
    sampledAt,
    usedPercent: window.usedPercent,
    resetsAt: resetMillis(window),
  }));
}

const normalizeEmail = (email: string | undefined) => email?.trim().toLowerCase() ?? "";

/** Readings from every provider the Limits view would show. */
export function observeProviders(
  providers: ReadonlyArray<ServerProvider>,
): UsageLimitObservation[] {
  return providersWithLimits(providers).flatMap((provider) =>
    provider.usageLimits
      ? observeLimits(
          {
            subject: { _tag: "instance", instanceId: provider.instanceId },
            driver: provider.driver,
            email: normalizeEmail(provider.auth.email),
            workspaceId: provider.auth.workspaceId ?? "",
          },
          provider.usageLimits,
        )
      : [],
  );
}

/** Readings from every hub account with usable limits. */
export function observeSources(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): UsageLimitObservation[] {
  return sources.flatMap((source) =>
    source.accounts.flatMap((account) =>
      observeLimits(
        {
          subject: { _tag: "source", sourceId: source.id, accountId: account.id },
          driver: account.driver,
          email: normalizeEmail(account.email),
          workspaceId: account.workspaceId ?? "",
        },
        account.usageLimits,
      ),
    ),
  );
}

export const KEEPALIVE_MS = 60 * 60_000;
const MIN_USED_DELTA = 0.5;

/**
 * Whether a reading carries news the last stored row lacks. A failed probe
 * republishes old limits under the old `checkedAt`, and every probe bumps
 * `checkedAt` even when nothing moved, so only content and the hourly
 * keepalive count. The keepalive proves a flat stretch was flat.
 */
export function shouldRecord(
  last: UsageLimitReading | undefined,
  next: UsageLimitReading,
): boolean {
  if (!last) return true;
  if (next.sampledAt <= last.sampledAt) return false;
  return (
    !samePeriod(last, next) ||
    Math.abs(next.usedPercent - last.usedPercent) >= MIN_USED_DELTA ||
    next.sampledAt - last.sampledAt >= KEEPALIVE_MS
  );
}

/**
 * One series' rows, oldest first, thinned to at most `maxPoints` and grouped
 * into periods. Time from `sinceMs` to `nowMs` is cut into equal buckets
 * (at least `requestedResolutionMs` wide) and the last reading of each is
 * kept, plus the first and last reading of every period so a reset keeps its
 * edge. Rows before `sinceMs` (the carry-in) share one bucket. When every
 * reading opens its own period, as a rolling window's moving reset does, the
 * edges alone would exceed the cap, so only the buckets are kept.
 */
export function toHistoryPeriods(
  rows: ReadonlyArray<UsageLimitReading>,
  options: {
    readonly sinceMs: number;
    readonly nowMs: number;
    readonly requestedResolutionMs: number | undefined;
    readonly maxPoints: number;
  },
): UsageLimitHistoryPeriod[] {
  const { sinceMs, nowMs, maxPoints } = options;
  // One bucket is reserved for the carry-in row before `sinceMs`.
  const resolutionMs = Math.max(
    options.requestedResolutionMs || 1,
    Math.ceil(Math.max(1, nowMs - sinceMs) / (maxPoints - 2)),
  );
  const lastBucket = Math.floor(Math.max(0, nowMs - sinceMs) / resolutionMs);
  const bucketOf = (row: UsageLimitReading) =>
    row.sampledAt < sinceMs
      ? -1
      : Math.min(lastBucket, Math.floor((row.sampledAt - sinceMs) / resolutionMs));
  const opensPeriod = rows.map((row, index) => {
    const previous = rows[index - 1];
    return previous === undefined || !samePeriod(previous, row);
  });
  const lastOfBucket = rows.map(
    (row, index) => index === rows.length - 1 || bucketOf(rows[index + 1]!) !== bucketOf(row),
  );
  const edge = rows.map((_, index) => opensPeriod[index]! || (opensPeriod[index + 1] ?? true));
  const withEdges = rows.map((_, index) => lastOfBucket[index]! || edge[index]!);
  const keep = withEdges.filter(Boolean).length <= maxPoints ? withEdges : lastOfBucket;

  const periods: Array<{ resetsAtMs: number | null; points: Array<readonly [number, number]> }> =
    [];
  // A period whose opening reading was thinned away still starts at its next kept reading.
  let opened = false;
  rows.forEach((row, index) => {
    opened ||= opensPeriod[index]!;
    if (!keep[index]) return;
    if (opened) periods.push({ resetsAtMs: row.resetsAt, points: [] });
    opened = false;
    periods.at(-1)!.points.push([row.sampledAt, row.usedPercent]);
  });
  return periods;
}
