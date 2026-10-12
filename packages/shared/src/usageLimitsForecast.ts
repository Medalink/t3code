/**
 * Drain rate and sawtooth projection for one pooled quota window, shared by
 * web and mobile so both draw the same line. Everything is pure: `now` is a
 * parameter and history arrives as a `LimitHistoryIndex`.
 *
 * @module usageLimitsForecast
 */
import type { UsageLimitHistoryInput } from "@t3tools/contracts";

import {
  type LimitHistoryIndex,
  type LimitPeriod,
  type LimitPoolMember,
  type LimitPoolWindow,
  type LimitSample,
  foldLimitPeriods,
  limitPoolKey,
  resetMillis,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Readings further apart than this are not joined by a line. */
const GAP_MS = 4 * HOUR;
const HISTORY_REQUEST_DAYS = 10;
const MIN_FIT_SPAN_MS = 10 * MINUTE;
const PROJECTION_EVENT_CAP = 10_000;
const DRAIN_BUCKETS = 48;
const DRAIN_BUCKET_STEPS = [
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

export interface ForecastPoint {
  readonly at: number;
  /** Additive percent: remaining (0..capacity) or drain per hour, by series. */
  readonly value: number;
}

/** A per-hour figure only exists together with where it came from. */
export type ForecastDrain =
  | { readonly basis: "fitted" | "pace" | "manual"; readonly perHour: number }
  | { readonly basis: "insufficient"; readonly reason: "noClock" | "noReadings" };

export interface ForecastOptions {
  readonly now: number;
  readonly horizonMs: number;
  readonly lookbackMs: number;
  /** Additive % per hour for the whole pool; replaces the fitted drain. */
  readonly drainOverridePerHour: number | null;
  /** True: a dry member's share of the drain moves to the others. False: members drain independently. */
  readonly spillover: boolean;
}

export interface LimitForecast {
  /** Members × 100. */
  readonly capacityPercent: number;
  /** Σ(100 − used) at `now`, after a stale reset has rolled over. */
  readonly remainingPercent: number;
  readonly drain: ForecastDrain;
  /** Solid segments, split at gaps longer than `GAP_MS`; the last one ends at `now`. */
  readonly observed: ReadonlyArray<readonly ForecastPoint[]>;
  /** Dashed; starts at `now`; empty when the drain is insufficient. */
  readonly projected: readonly ForecastPoint[];
  /** Drain-rate tab: additive %/h per bucket, each point at its bucket's end. */
  readonly drainSeries: readonly ForecastPoint[];
  readonly nextReset: { readonly at: number; readonly restoresPercent: number } | null;
  /** First projected moment the pool reaches 0. */
  readonly emptyAt: number | null;
}

export function limitHistoryRequest(now: number): UsageLimitHistoryInput {
  const floor = now - (now % (15 * MINUTE));
  return { sinceMs: floor - HISTORY_REQUEST_DAYS * DAY };
}

export const DEFAULT_FORECAST_HORIZON_DAYS: Record<LimitPoolWindow["kind"], 1 | 7 | 30> = {
  session: 1,
  weekly: 7,
  monthly: 30,
  other: 30,
};

/** `3.3%`, `12%`, `0.4%`. */
export function formatDrainPerHour(perHour: number): string {
  const rounded = perHour >= 10 ? Math.round(perHour) : Math.round(perHour * 10) / 10;
  return `${rounded}%`;
}

interface Reading extends LimitSample {
  readonly resetsAt: number | null;
}

interface MemberFit {
  readonly rate: number;
  readonly basis: "fitted" | "pace";
}

interface Member {
  readonly remaining: number;
  readonly resetAt: number | null;
  readonly periodMs: number | null;
  readonly periods: readonly LimitPeriod[];
  readonly fit: MemberFit | null;
}

function prepareMember(member: LimitPoolMember, history: LimitHistoryIndex, now: number): Member {
  const { window, account } = member;
  const periodMs =
    window.windowDurationMins !== undefined && window.windowDurationMins >= 1
      ? window.windowDurationMins * MINUTE
      : null;
  const reportedReset = resetMillis(window);
  const checked = Date.parse(account.limits.checkedAt);
  const live: Reading = {
    at: Number.isFinite(checked) ? Math.min(checked, now) : now,
    usedPercent: window.usedPercent,
    resetsAt: reportedReset,
  };
  const recorded = history.get(account.identity)?.get(limitPoolKey(account.driver, window)) ?? [];
  const periods = foldLimitPeriods([
    ...recorded.flatMap((period) =>
      period.samples.map((sample) => ({
        at: Math.min(sample.at, now),
        usedPercent: sample.usedPercent,
        resetsAt: period.resetsAt,
      })),
    ),
    live,
  ]);
  const current = periods.at(-1)!;
  const { resetAt, anchorReset, fitAt } = rolledWindow(
    reportedReset,
    periodMs,
    now,
    current.resetsAt,
  );
  const anchor =
    anchorReset !== null && periodMs !== null
      ? { at: anchorReset - periodMs, usedPercent: 0 }
      : null;
  return {
    remaining: 100 - (usedAt(periods, now, "after") ?? 0),
    resetAt,
    periodMs,
    periods,
    fit: fitRate(anchor, current.samples, fitAt, periodMs),
  };
}

function rolledWindow(
  reportedReset: number | null,
  periodMs: number | null,
  now: number,
  periodReset: number | null,
): { resetAt: number | null; anchorReset: number | null; fitAt: number } {
  if (reportedReset === null || reportedReset > now) {
    return { resetAt: reportedReset, anchorReset: reportedReset, fitAt: now };
  }
  return {
    resetAt:
      periodMs === null
        ? null
        : reportedReset + Math.ceil((now - reportedReset + 1) / periodMs) * periodMs,
    anchorReset: periodReset,
    fitAt: periodReset ?? now,
  };
}

function fitRate(
  anchor: LimitSample | null,
  readings: readonly LimitSample[],
  at: number,
  periodMs: number | null,
): MemberFit | null {
  const points = anchor ? [anchor, ...readings] : readings;
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2 || last.at - first.at < MIN_FIT_SPAN_MS) return null;
  const readingSpan = readings.length > 0 ? readings.at(-1)!.at - readings[0]!.at : 0;
  const basis: MemberFit["basis"] | null =
    readings.length >= 3 && readingSpan >= Math.max((periodMs ?? 0) / 20, 30 * MINUTE)
      ? "fitted"
      : anchor && readings.length >= 1
        ? "pace"
        : null;
  if (basis === null) return null;
  const halfLife = Math.min(48 * HOUR, Math.max(HOUR, (periodMs ?? DAY) / 4));
  const weighted = points.map((point) => ({ ...point, w: 0.5 ** ((at - point.at) / halfLife) }));
  const totalWeight = weighted.reduce((sum, point) => sum + point.w, 0);
  const meanAt = weighted.reduce((sum, point) => sum + point.w * point.at, 0) / totalWeight;
  const meanUsed =
    weighted.reduce((sum, point) => sum + point.w * point.usedPercent, 0) / totalWeight;
  const covariance = weighted.reduce(
    (sum, point) => sum + point.w * (point.at - meanAt) * (point.usedPercent - meanUsed),
    0,
  );
  const variance = weighted.reduce((sum, point) => sum + point.w * (point.at - meanAt) ** 2, 0);
  if (variance === 0) return null;
  return { rate: Math.max(0, (covariance / variance) * HOUR), basis };
}

function periodAt(periods: readonly LimitPeriod[], at: number): LimitPeriod | null {
  let found: LimitPeriod | null = null;
  for (const period of periods) {
    if (period.samples[0]!.at > at) break;
    found = period;
  }
  return found;
}

function usedAt(
  periods: readonly LimitPeriod[],
  at: number,
  side: "before" | "after",
): number | null {
  const period = periodAt(periods, at);
  if (!period) return null;
  if (
    period.resetsAt !== null &&
    (side === "after" ? at >= period.resetsAt : at > period.resetsAt)
  ) {
    return 0;
  }
  const samples = period.samples;
  const last = samples.at(-1)!;
  if (at >= last.at) return last.usedPercent;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const from = samples[index]!;
    const to = samples[index + 1]!;
    if (from.at <= at && at <= to.at) {
      const share = to.at === from.at ? 1 : (at - from.at) / (to.at - from.at);
      return from.usedPercent + (to.usedPercent - from.usedPercent) * share;
    }
  }
  return last.usedPercent;
}

function resetCrossings(periods: readonly LimitPeriod[], from: number, to: number): number[] {
  return periods.flatMap((period) => {
    const reset = period.resetsAt;
    return reset !== null && from <= reset && reset <= to && periodAt(periods, reset) === period
      ? [reset]
      : [];
  });
}

function readingTimes(periods: readonly LimitPeriod[]): number[] {
  return periods.flatMap((period) => period.samples.map((sample) => sample.at));
}

function remainingTotal(members: readonly Member[], at: number, side: "before" | "after"): number {
  return members.reduce((sum, member) => sum + 100 - (usedAt(member.periods, at, side) ?? 0), 0);
}

function observe(
  members: readonly Member[],
  from: number,
  to: number,
): ReadonlyArray<readonly ForecastPoint[]> {
  const start = Math.max(from, ...members.map((member) => readingTimes(member.periods)[0]!));
  if (start > to) return [];
  const gaps = members
    .flatMap((member) => {
      const times = readingTimes(member.periods);
      return times.flatMap((at, index) => {
        const previous = times[index - 1];
        return previous !== undefined && at - previous > GAP_MS ? [{ from: previous, to: at }] : [];
      });
    })
    .sort((left, right) => left.from - right.from);
  const segments: Array<readonly [number, number]> = [];
  let cursor = start;
  for (const gap of gaps) {
    if (gap.to <= cursor) continue;
    if (gap.from > cursor) segments.push([cursor, Math.min(gap.from, to)]);
    cursor = Math.max(cursor, gap.to);
    if (cursor >= to) break;
  }
  if (cursor <= to) segments.push([cursor, to]);
  return segments.map(([segmentFrom, segmentTo]) => {
    const crossings = new Set(
      members.flatMap((member) => resetCrossings(member.periods, segmentFrom, segmentTo)),
    );
    const times = [
      ...new Set([
        segmentFrom,
        segmentTo,
        ...members.flatMap((member) =>
          readingTimes(member.periods).filter((at) => segmentFrom <= at && at <= segmentTo),
        ),
        ...crossings,
      ]),
    ].sort((left, right) => left - right);
    return times.flatMap((at) =>
      crossings.has(at)
        ? [
            { at, value: remainingTotal(members, at, "before") },
            { at, value: remainingTotal(members, at, "after") },
          ]
        : [{ at, value: remainingTotal(members, at, "after") }],
    );
  });
}

interface Simulated {
  remaining: number;
  resetAt: number | null;
  readonly periodMs: number | null;
  readonly share: number;
}

function project(
  members: readonly Member[],
  shares: readonly number[],
  perHour: number,
  spillover: boolean,
  from: number,
  to: number,
): {
  readonly points: readonly ForecastPoint[];
  readonly resets: ReadonlyArray<{ readonly at: number; readonly restored: number }>;
} {
  const state: Simulated[] = members.map((member, index) => ({
    remaining: member.remaining,
    resetAt: member.resetAt,
    periodMs: member.periodMs,
    share: shares[index] ?? 0,
  }));
  const total = () => state.reduce((sum, member) => sum + member.remaining, 0);
  const points: ForecastPoint[] = [{ at: from, value: total() }];
  const resets: Array<{ at: number; restored: number }> = [];
  let at = from;
  for (let events = 0; events < PROJECTION_EVENT_CAP && at < to; events += 1) {
    const active = state.filter((member) => member.remaining > 0 && member.share > 0);
    const activeShare = spillover
      ? active.reduce((sum, member) => sum + member.share, 0)
      : state.reduce((sum, member) => sum + member.share, 0);
    const rateOf = (member: Simulated) =>
      activeShare > 0 ? (perHour * member.share) / activeShare : 0;
    const emptyAt = Math.min(
      ...active.flatMap((member) => {
        const rate = rateOf(member);
        return rate > 0 ? [at + (member.remaining / rate) * HOUR] : [];
      }),
    );
    const resetAt = Math.min(
      ...state.flatMap((member) =>
        member.resetAt !== null && member.resetAt > at ? [member.resetAt] : [],
      ),
    );
    const next = Math.min(emptyAt, resetAt, to);
    for (const member of active) {
      member.remaining = Math.max(0, member.remaining - (rateOf(member) * (next - at)) / HOUR);
      if (member.remaining < 1e-9) member.remaining = 0;
    }
    at = next;
    points.push({ at, value: total() });
    if (at >= to) break;
    let restored = 0;
    for (const member of state) {
      if (member.resetAt === null || member.resetAt > at) continue;
      restored += 100 - member.remaining;
      member.remaining = 100;
      member.resetAt = member.periodMs === null ? null : member.resetAt + member.periodMs;
    }
    if (restored > 0) {
      points.push({ at, value: total() });
      resets.push({ at, restored });
    }
  }
  return { points, resets };
}

function niceDuration(raw: number): number {
  return DRAIN_BUCKET_STEPS.find((step) => step >= raw) ?? DRAIN_BUCKET_STEPS.at(-1)!;
}

function consumedBetween(member: Member, from: number, to: number): number {
  const edges = [
    from,
    ...resetCrossings(member.periods, from, to).filter((at) => at > from && at < to),
    to,
  ];
  let consumed = 0;
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = usedAt(member.periods, edges[index]!, "after");
    const end = usedAt(member.periods, edges[index + 1]!, "before");
    if (start !== null && end !== null) consumed += Math.max(0, end - start);
  }
  return consumed;
}

function drainBuckets(
  members: readonly Member[],
  from: number,
  to: number,
): readonly ForecastPoint[] {
  const start = Math.max(from, ...members.map((member) => readingTimes(member.periods)[0]!));
  const bucket = niceDuration((to - from) / DRAIN_BUCKETS);
  const count = Math.ceil((to - from) / bucket);
  const points: ForecastPoint[] = [];
  for (let index = count; index >= 1; index -= 1) {
    const bucketTo = to - (index - 1) * bucket;
    const bucketFrom = bucketTo - bucket;
    if (bucketTo <= start) continue;
    const consumed = members.reduce(
      (sum, member) => sum + consumedBetween(member, bucketFrom, bucketTo),
      0,
    );
    points.push({ at: bucketTo, value: consumed / (bucket / HOUR) });
  }
  return points;
}

/** The whole forecast for one pooled window. Pure: `now` is a parameter, no I/O. */
export function forecastPoolWindow(
  pool: LimitPoolWindow,
  history: LimitHistoryIndex,
  options: ForecastOptions,
): LimitForecast {
  const { now, horizonMs, lookbackMs, drainOverridePerHour, spillover } = options;
  const members = pool.members.map((member) => prepareMember(member, history, now));
  const capacityPercent = members.length * 100;
  const remainingPercent = Math.round(members.reduce((sum, member) => sum + member.remaining, 0));
  const observed = members.length > 0 ? observe(members, now - lookbackMs, now) : [];
  const drainSeries = members.length > 0 ? drainBuckets(members, now - lookbackMs, now) : [];

  const fitted = members.flatMap((member) => (member.fit ? [member.fit.rate] : []));
  const meanRate = fitted.length > 0 ? fitted.reduce((sum, r) => sum + r, 0) / fitted.length : null;
  const rates = members.map((member) =>
    member.fit ? member.fit.rate : member.resetAt !== null ? meanRate : null,
  );
  const totalRate = rates.reduce<number>((sum, rate) => sum + (rate ?? 0), 0);
  const anyClocked = members.some((member) => member.resetAt !== null);
  const drain: ForecastDrain =
    drainOverridePerHour !== null
      ? { basis: "manual", perHour: drainOverridePerHour }
      : fitted.length > 0
        ? {
            basis: members.some((member) => member.fit?.basis === "fitted") ? "fitted" : "pace",
            perHour: totalRate,
          }
        : { basis: "insufficient", reason: anyClocked ? "noReadings" : "noClock" };
  if (drain.basis === "insufficient") {
    return {
      capacityPercent,
      remainingPercent,
      drain,
      observed,
      projected: [],
      drainSeries,
      nextReset: null,
      emptyAt: null,
    };
  }
  const shares =
    totalRate > 0
      ? rates.map((rate) => (rate ?? 0) / totalRate)
      : members.map((member) =>
          member.resetAt !== null || (drainOverridePerHour !== null && !anyClocked) ? 1 : 0,
        );
  const shareTotal = shares.reduce((sum, share) => sum + share, 0);
  const { points, resets } = project(
    members,
    shares.map((share) => (shareTotal > 0 ? share / shareTotal : 0)),
    drain.perHour,
    spillover,
    now,
    now + horizonMs,
  );
  const firstReset = resets.find((reset) => reset.restored >= 1);
  const nextReset = firstReset
    ? {
        at: firstReset.at,
        restoresPercent: Math.round(
          resets
            .filter((reset) => reset.at >= firstReset.at && reset.at - firstReset.at <= MINUTE)
            .reduce((sum, reset) => sum + reset.restored, 0),
        ),
      }
    : null;
  return {
    capacityPercent,
    remainingPercent,
    drain,
    observed,
    projected: points,
    drainSeries,
    nextReset,
    emptyAt: points.find((point) => point.value <= 1e-9)?.at ?? null,
  };
}
