import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  type LimitHistoryIndex,
  type LimitPeriod,
  type LimitPoolMember,
  type LimitPoolWindow,
} from "./usageLimits.ts";
import {
  type ForecastOptions,
  type LimitForecast,
  defaultForecastHorizonDays,
  forecastPoolWindow,
  formatDrainPerHour,
  limitHistoryRequest,
  samePeriod,
} from "./usageLimitsForecast.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.parse("2026-09-03T12:00:00.000Z");
const at = (iso: string) => Date.parse(iso);
const claude = ProviderDriverKind.make("claudeAgent");

const account = (identity: string, checkedAt = "2026-09-03T12:00:00.000Z"): LimitAccount => ({
  key: identity,
  identity,
  reportedBy: [],
  driver: claude,
  displayName: identity,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt, windows: [] },
});

const session: ServerProviderUsageWindow = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 30,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
};

function member(
  identity: string,
  window: Partial<ServerProviderUsageWindow>,
  checkedAt?: string,
): LimitPoolMember {
  const merged = { ...session, ...window };
  const owner = account(identity, checkedAt);
  return { account: { ...owner, limits: { ...owner.limits, windows: [merged] } }, window: merged };
}

function poolWindow(...members: LimitPoolMember[]): LimitPoolWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    members,
    columns: members.map(({ account, window }) => ({ account, window })),
    remainingPercent: 0,
    usedPercent: 0,
    pace: null,
    resets: [],
  };
}

function history(
  ...entries: Array<[identity: string, periods: readonly LimitPeriod[]]>
): LimitHistoryIndex {
  return new Map(
    entries.map(([identity, periods]) => [identity, new Map([["session:five_hour", periods]])]),
  );
}

const perHour = (forecast: LimitForecast) =>
  forecast.drain.basis === "insufficient" ? Number.NaN : forecast.drain.perHour;

const options = (overrides: Partial<ForecastOptions> = {}): ForecastOptions => ({
  now,
  horizonMs: DAY,
  lookbackMs: 8 * HOUR,
  drainOverridePerHour: null,
  spillover: true,
  ...overrides,
});

describe("forecastPoolWindow drain", () => {
  it("fits pace from the period anchor and the live reading when there is no history", () => {
    const forecast = forecastPoolWindow(poolWindow(member("a", {})), history(), options());
    expect(forecast.drain).toMatchObject({ basis: "pace" });
    expect(perHour(forecast)).toBeCloseTo(10);
    expect(forecast.remainingPercent).toBe(70);
    expect(forecast.capacityPercent).toBe(100);
  });

  it("weights a burst in the last hour over a quiet start", () => {
    const reset = at("2026-09-03T14:00:00.000Z");
    const readings = [
      ["2026-09-03T09:30:00.000Z", 2],
      ["2026-09-03T10:00:00.000Z", 4],
      ["2026-09-03T10:30:00.000Z", 6],
      ["2026-09-03T11:00:00.000Z", 8],
      ["2026-09-03T11:30:00.000Z", 28],
    ] as const;
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 48 })),
      history([
        "a",
        [
          {
            resetsAt: reset,
            samples: readings.map(([iso, usedPercent]) => ({ at: at(iso), usedPercent })),
          },
        ],
      ]),
      options(),
    );
    expect(forecast.drain).toMatchObject({ basis: "fitted" });
    expect(perHour(forecast)).toBeGreaterThan(17);
  });

  it("borrows the mean fitted rate for a clocked member that cannot fit on its own", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", {}), member("b", { windowDurationMins: undefined, usedPercent: 50 })),
      history(),
      options(),
    );
    expect(forecast.drain).toMatchObject({ basis: "pace" });
    expect(perHour(forecast)).toBeCloseTo(20);
  });

  it("reports no clock when nothing resets and no rate was given, but still draws observed", () => {
    const forecast = forecastPoolWindow(
      poolWindow(
        member("a", { resetsAt: undefined, windowDurationMins: undefined, usedPercent: 40 }),
      ),
      history(),
      options(),
    );
    expect(forecast.drain).toEqual({ basis: "insufficient", reason: "noClock" });
    expect(forecast.projected).toEqual([]);
    expect(forecast.nextReset).toBeNull();
    expect(forecast.observed).toEqual([[{ at: now, value: 60 }]]);
  });

  it("reports no readings when a member has a clock but nothing to fit", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { windowDurationMins: undefined })),
      history(),
      options(),
    );
    expect(forecast.drain).toEqual({ basis: "insufficient", reason: "noReadings" });
  });

  it("lets a manual rate replace the fit and draws a straight line when nothing resets", () => {
    const forecast = forecastPoolWindow(
      poolWindow(
        member("a", { resetsAt: undefined, windowDurationMins: undefined, usedPercent: 40 }),
      ),
      history(),
      options({ drainOverridePerHour: 5 }),
    );
    expect(forecast.drain).toEqual({ basis: "manual", perHour: 5 });
    expect(forecast.projected).toEqual([
      { at: now, value: 60 },
      { at: now + 12 * HOUR, value: 0 },
      { at: now + DAY, value: 0 },
    ]);
    expect(forecast.emptyAt).toBe(now + 12 * HOUR);
  });

  it("adds remaining and capacity across members instead of averaging", () => {
    const forecast = forecastPoolWindow(
      poolWindow(
        member("a", { usedPercent: 50 }),
        member("b", { usedPercent: 50 }),
        member("c", { usedPercent: 50 }),
      ),
      history(),
      options(),
    );
    expect(forecast.capacityPercent).toBe(300);
    expect(forecast.remainingPercent).toBe(150);
  });
});

describe("forecastPoolWindow projection", () => {
  it("steps to 100 at each recurring reset, restoring the projected amount, until the horizon", () => {
    const forecast = forecastPoolWindow(poolWindow(member("a", {})), history(), options());
    expect(
      forecast.projected.map((point) => ({ ...point, value: Math.round(point.value) })),
    ).toEqual([
      { at: now, value: 70 },
      { at: at("2026-09-03T14:00:00.000Z"), value: 50 },
      { at: at("2026-09-03T14:00:00.000Z"), value: 100 },
      { at: at("2026-09-03T19:00:00.000Z"), value: 50 },
      { at: at("2026-09-03T19:00:00.000Z"), value: 100 },
      { at: at("2026-09-04T00:00:00.000Z"), value: 50 },
      { at: at("2026-09-04T00:00:00.000Z"), value: 100 },
      { at: at("2026-09-04T05:00:00.000Z"), value: 50 },
      { at: at("2026-09-04T05:00:00.000Z"), value: 100 },
      { at: at("2026-09-04T10:00:00.000Z"), value: 50 },
      { at: at("2026-09-04T10:00:00.000Z"), value: 100 },
      { at: at("2026-09-04T12:00:00.000Z"), value: 80 },
    ]);
    expect(forecast.nextReset).toEqual({ at: at("2026-09-03T14:00:00.000Z"), restoresPercent: 50 });
    expect(forecast.emptyAt).toBeNull();
  });

  it("runs dry, stays flat until the reset, and does not spin on an emptied member", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 90 })),
      history(),
      options({ horizonMs: 8 * HOUR }),
    );
    expect(forecast.projected).toEqual([
      { at: now, value: 10 },
      { at: at("2026-09-03T12:20:00.000Z"), value: 0 },
      { at: at("2026-09-03T14:00:00.000Z"), value: 0 },
      { at: at("2026-09-03T14:00:00.000Z"), value: 100 },
      { at: at("2026-09-03T17:20:00.000Z"), value: 0 },
      { at: at("2026-09-03T19:00:00.000Z"), value: 0 },
      { at: at("2026-09-03T19:00:00.000Z"), value: 100 },
      { at: at("2026-09-03T20:00:00.000Z"), value: 70 },
    ]);
    expect(forecast.emptyAt).toBe(at("2026-09-03T12:20:00.000Z"));
  });

  it("snaps a floating-point residue to zero instead of spinning on an almost-empty member", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 61 })),
      history(),
      options({ horizonMs: 3 * HOUR }),
    );
    expect(forecast.projected.map((point) => Math.round(point.value * 1000) / 1000)).toEqual([
      39,
      0,
      0,
      100,
      Math.round((100 - 61 / 3) * 1000) / 1000,
    ]);
    expect(forecast.projected[1]?.at).toBeCloseTo(now + (39 / (61 / 3)) * HOUR, 3);
    expect(forecast.emptyAt).toBe(forecast.projected[1]?.at);
  });

  it("treats a reset already in the past as full, resetting one duration later with the old fit", () => {
    const forecast = forecastPoolWindow(
      poolWindow(
        member(
          "a",
          { usedPercent: 80, resetsAt: "2026-09-03T11:00:00.000Z" },
          "2026-09-03T10:30:00.000Z",
        ),
      ),
      history(),
      options(),
    );
    expect(forecast.remainingPercent).toBe(100);
    expect(forecast.drain).toMatchObject({ basis: "pace" });
    expect(perHour(forecast)).toBeCloseTo(80 / 4.5);
    expect(forecast.projected[0]).toEqual({ at: now, value: 100 });
    expect(forecast.nextReset).toEqual({ at: at("2026-09-03T16:00:00.000Z"), restoresPercent: 71 });
  });

  it.each([
    ["spills a dry member's share onto the rest", true, 20],
    ["keeps members independent when spillover is off", false, 40],
  ])("%s", (_name, spillover, remainingAtEnd) => {
    const tenHour = { windowDurationMins: 600, resetsAt: "2026-09-03T17:00:00.000Z" };
    const forecast = forecastPoolWindow(
      poolWindow(
        member("a", { ...tenHour, usedPercent: 60 }),
        member("b", { ...tenHour, usedPercent: 30 }),
      ),
      history(),
      options({ horizonMs: 5 * HOUR, spillover }),
    );
    expect(forecast.drain).toEqual({ basis: "pace", perHour: 18 });
    expect(forecast.projected.map((point) => point.at)).toEqual([
      now,
      at("2026-09-03T15:20:00.000Z"),
      at("2026-09-03T17:00:00.000Z"),
    ]);
    expect(forecast.projected.map((point) => point.value)[1]).toBeCloseTo(50);
    expect(forecast.projected.map((point) => point.value)[2]).toBeCloseTo(remainingAtEnd);
  });

  it("skips an untouched account's reset and merges resets landing within a minute", () => {
    const forecast = forecastPoolWindow(
      poolWindow(
        member("untouched", { usedPercent: 0 }),
        member("b", { usedPercent: 50, resetsAt: "2026-09-03T14:00:30.000Z" }),
        member("c", { usedPercent: 40, resetsAt: "2026-09-03T14:01:00.000Z" }),
      ),
      history(),
      options(),
    );
    expect(forecast.nextReset?.at).toBe(at("2026-09-03T14:00:30.000Z"));
    expect(forecast.nextReset?.restoresPercent).toBeGreaterThan(100);
  });
});

describe("forecastPoolWindow observed", () => {
  it("starts where every member has a reading and steps vertically at a recorded reset", () => {
    const forecast = forecastPoolWindow(
      poolWindow(
        member("a", { resetsAt: "2026-09-03T15:00:00.000Z" }),
        member("b", { usedPercent: 20, resetsAt: "2026-09-03T15:00:00.000Z" }),
      ),
      history(
        [
          "a",
          [
            {
              resetsAt: at("2026-09-03T10:00:00.000Z"),
              samples: [
                { at: at("2026-09-03T08:00:00.000Z"), usedPercent: 60 },
                { at: at("2026-09-03T09:00:00.000Z"), usedPercent: 80 },
              ],
            },
            {
              resetsAt: at("2026-09-03T15:00:00.000Z"),
              samples: [{ at: at("2026-09-03T11:00:00.000Z"), usedPercent: 20 }],
            },
          ],
        ],
        [
          "b",
          [
            {
              resetsAt: at("2026-09-03T15:00:00.000Z"),
              samples: [{ at: at("2026-09-03T09:30:00.000Z"), usedPercent: 10 }],
            },
          ],
        ],
      ),
      options(),
    );
    expect(forecast.observed).toEqual([
      [
        { at: at("2026-09-03T09:30:00.000Z"), value: 110 },
        { at: at("2026-09-03T10:00:00.000Z"), value: 108 },
        { at: at("2026-09-03T10:00:00.000Z"), value: 188 },
        { at: at("2026-09-03T11:00:00.000Z"), value: 164 },
        { at: now, value: 150 },
      ],
    ]);
  });

  it("breaks the line at a gap longer than four hours and still ends at now", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 40 })),
      history([
        "a",
        [
          {
            resetsAt: at("2026-09-03T14:00:00.000Z"),
            samples: [
              { at: at("2026-09-03T02:00:00.000Z"), usedPercent: 10 },
              { at: at("2026-09-03T03:00:00.000Z"), usedPercent: 12 },
            ],
          },
        ],
      ]),
      options({ lookbackMs: 12 * HOUR }),
    );
    expect(forecast.observed).toEqual([
      [
        { at: at("2026-09-03T02:00:00.000Z"), value: 90 },
        { at: at("2026-09-03T03:00:00.000Z"), value: 88 },
      ],
      [{ at: now, value: 60 }],
    ]);
  });

  it("clamps readings stamped after now so observed ends at the Now marker", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 45 }, "2026-09-03T12:05:00.000Z")),
      history([
        "a",
        [
          {
            resetsAt: at("2026-09-03T14:00:00.000Z"),
            samples: [{ at: at("2026-09-03T12:10:00.000Z"), usedPercent: 50 }],
          },
        ],
      ]),
      options(),
    );
    expect(forecast.observed).toEqual([[{ at: now, value: 50 }]]);
    expect(forecast.projected[0]).toEqual({ at: now, value: 50 });
  });

  it("flattens a dip inside a period with the running max", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 30 })),
      history([
        "a",
        [
          {
            resetsAt: at("2026-09-03T14:00:00.000Z"),
            samples: [
              { at: at("2026-09-03T11:00:00.000Z"), usedPercent: 35 },
              { at: at("2026-09-03T11:30:00.000Z"), usedPercent: 35 },
            ],
          },
        ],
      ]),
      options(),
    );
    expect(forecast.observed).toEqual([
      [
        { at: at("2026-09-03T11:00:00.000Z"), value: 65 },
        { at: at("2026-09-03T11:30:00.000Z"), value: 65 },
        { at: now, value: 65 },
      ],
    ]);
    expect(forecast.remainingPercent).toBe(65);
  });
});

describe("forecastPoolWindow drain series", () => {
  it("buckets consumption per hour and carries it across a recorded reset", () => {
    const forecast = forecastPoolWindow(
      poolWindow(member("a", { usedPercent: 15, resetsAt: "2026-09-03T16:00:00.000Z" })),
      history([
        "a",
        [
          {
            resetsAt: at("2026-09-03T10:45:00.000Z"),
            samples: [
              { at: at("2026-09-03T10:00:00.000Z"), usedPercent: 50 },
              { at: at("2026-09-03T10:30:00.000Z"), usedPercent: 60 },
            ],
          },
          {
            resetsAt: at("2026-09-03T16:00:00.000Z"),
            samples: [{ at: at("2026-09-03T10:50:00.000Z"), usedPercent: 5 }],
          },
        ],
      ]),
      options({ lookbackMs: 48 * HOUR }),
    );
    expect(forecast.drainSeries.map((point) => point.at)).toEqual([
      at("2026-09-03T11:00:00.000Z"),
      now,
    ]);
    expect(forecast.drainSeries[0]?.value).toBeCloseTo(10 + 5 + 10 / 7, 5);
    expect(forecast.drainSeries[1]?.value).toBeCloseTo(15 - (5 + 10 / 7), 5);
  });
});

describe("helpers", () => {
  it("re-exports samePeriod for the server recorder", () => {
    expect(samePeriod({ resetsAt: null, usedPercent: 1 }, { resetsAt: null, usedPercent: 2 })).toBe(
      true,
    );
  });

  it("floors the history request to the quarter hour so refreshes share a key", () => {
    const request = limitHistoryRequest(at("2026-09-03T12:07:33.000Z"));
    expect(request).toEqual({ sinceMs: now - 10 * DAY });
    expect(limitHistoryRequest(at("2026-09-03T12:14:59.999Z"))).toEqual(request);
    expect(limitHistoryRequest(at("2026-09-03T12:15:00.000Z"))).not.toEqual(request);
  });

  it.each([
    ["session", 1],
    ["weekly", 7],
    ["monthly", 30],
    ["other", 30],
  ] as const)("defaults a %s window to %i days", (kind, days) => {
    expect(defaultForecastHorizonDays(kind)).toBe(days);
  });

  it.each([
    [3.3, "3.3%"],
    [12, "12%"],
    [0.4, "0.4%"],
    [9.96, "10%"],
    [0, "0%"],
  ])("formats %f per hour as %s", (perHour, label) => {
    expect(formatDrainPerHour(perHour)).toBe(label);
  });
});
