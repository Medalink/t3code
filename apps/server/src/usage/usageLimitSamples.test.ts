import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KEEPALIVE_MS,
  observeProviders,
  observeSources,
  seriesKey,
  shouldRecord,
  toHistoryPeriods,
  type UsageLimitReading,
} from "./usageLimitSamples.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const HOUR = 60 * 60_000;
const resetsAt = Date.parse("2026-09-03T14:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: " Me@Example.com ", workspaceId: "ws-1" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
    ...overrides,
  };
}

const reading = (overrides: Partial<UsageLimitReading> = {}): UsageLimitReading => ({
  sampledAt: now,
  usedPercent: 40,
  resetsAt,
  ...overrides,
});

describe("shouldRecord", () => {
  const last = reading();
  it.each([
    ["the first reading of a series", undefined, reading(), true],
    ["identical values under a fresh checkedAt", last, reading({ sampledAt: now + 60_000 }), false],
    ["a failed probe republishing the same checkedAt", last, reading({ usedPercent: 45 }), false],
    [
      "a reading older than the last row",
      last,
      reading({ sampledAt: now - 1, usedPercent: 45 }),
      false,
    ],
    ["a 0.4 point rise", last, reading({ sampledAt: now + 60_000, usedPercent: 40.4 }), false],
    ["a 0.5 point rise", last, reading({ sampledAt: now + 60_000, usedPercent: 40.5 }), true],
    ["a 2 point dip, kept raw", last, reading({ sampledAt: now + 60_000, usedPercent: 38 }), true],
    [
      "two minutes of reset jitter",
      last,
      reading({ sampledAt: now + 60_000, resetsAt: resetsAt + 2 * 60_000 }),
      false,
    ],
    [
      "a new period",
      last,
      reading({ sampledAt: now + 60_000, usedPercent: 0, resetsAt: resetsAt + 5 * HOUR }),
      true,
    ],
    [
      "a reset time that vanished",
      last,
      reading({ sampledAt: now + 60_000, resetsAt: null }),
      true,
    ],
    ["an hour flat", last, reading({ sampledAt: now + KEEPALIVE_MS }), true],
    ["just under an hour flat", last, reading({ sampledAt: now + KEEPALIVE_MS - 1 }), false],
  ])("%s → %s", (_, previous, next, expected) => {
    expect(shouldRecord(previous, next)).toBe(expected);
  });
});

describe("observeProviders", () => {
  it("flattens each window with the identity it was read under", () => {
    expect(observeProviders([provider({})])).toEqual([
      {
        subject: { _tag: "instance", instanceId: "codex" },
        driver: "codex",
        email: "me@example.com",
        workspaceId: "ws-1",
        credentialFingerprint: "",
        windowKind: "session",
        windowId: "five_hour",
        sampledAt: now,
        usedPercent: 40,
        resetsAt,
      },
    ]);
  });

  it("skips what the Limits view would not draw", () => {
    expect(
      observeProviders([
        provider({ enabled: false }),
        provider({ installed: false }),
        provider({ usageLimits: undefined }),
        provider({ usageLimits: { checkedAt: "2026-09-03T12:00:00.000Z", windows: [] } }),
        provider({
          usageLimits: {
            checkedAt: "2026-09-03T12:00:00.000Z",
            windows: [window],
            unavailable: { reason: "probeFailed" },
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("names a series apart for each signed-in account on one instance", () => {
    const [before] = observeProviders([provider({})]);
    const [after] = observeProviders([
      provider({ auth: { status: "authenticated", email: "other@example.com" } }),
    ]);
    expect(seriesKey(before!)).not.toBe(seriesKey(after!));
  });
});

describe("observeSources", () => {
  it("keys hub accounts by source and account", () => {
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy",
      label: "Hub",
      checkedAt: "2026-09-03T12:00:00.000Z",
      accounts: [
        {
          id: "codex-a.json",
          driver: ProviderDriverKind.make("codex"),
          email: "Me@Example.com",
          usageLimits: {
            checkedAt: "2026-09-03T12:00:00.000Z",
            windows: [window],
            credentialFingerprint: "fp",
          },
        },
        {
          id: "broken.json",
          driver: ProviderDriverKind.make("codex"),
          usageLimits: {
            checkedAt: "2026-09-03T12:00:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed" },
          },
        },
      ],
    };
    expect(observeSources([source])).toEqual([
      expect.objectContaining({
        subject: { _tag: "source", sourceId: "hub", accountId: "codex-a.json" },
        email: "me@example.com",
        workspaceId: "",
        credentialFingerprint: "fp",
      }),
    ]);
  });
});

describe("toHistoryPeriods", () => {
  const sinceMs = now - 10 * HOUR;
  const options = { sinceMs, nowMs: now, maxPoints: 600 };

  it("splits on a reset and keeps both sides of the edge", () => {
    const rows = [
      reading({ sampledAt: sinceMs - HOUR, usedPercent: 10 }),
      reading({ sampledAt: sinceMs + HOUR, usedPercent: 30 }),
      reading({ sampledAt: sinceMs + 2 * HOUR, usedPercent: 0, resetsAt: resetsAt + 5 * HOUR }),
      reading({ sampledAt: sinceMs + 3 * HOUR, usedPercent: 5, resetsAt: resetsAt + 5 * HOUR }),
    ];
    expect(toHistoryPeriods(rows, options)).toEqual([
      {
        resetsAtMs: resetsAt,
        points: [
          [sinceMs - HOUR, 10],
          [sinceMs + HOUR, 30],
        ],
      },
      {
        resetsAtMs: resetsAt + 5 * HOUR,
        points: [
          [sinceMs + 2 * HOUR, 0],
          [sinceMs + 3 * HOUR, 5],
        ],
      },
    ]);
  });

  it("thins to the last reading per bucket but keeps every period's first and last", () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      reading({ sampledAt: sinceMs + index * 60_000, usedPercent: 10 + index * 0.5 }),
    );
    const [period] = toHistoryPeriods(rows, { ...options, maxPoints: 42 });
    expect(period!.points.map(([at]) => (at - sinceMs) / 60_000)).toEqual([0, 14, 29, 44, 59]);
  });

  it("never exceeds the cap when every reading opens its own period", () => {
    const rows = Array.from({ length: 100 }, (_, index) => {
      const sampledAt = sinceMs + index * 6 * 60_000;
      return reading({ sampledAt, resetsAt: sampledAt + 5 * HOUR });
    });
    const periods = toHistoryPeriods(rows, { ...options, maxPoints: 20 });
    const points = periods.flatMap((period) => period.points);
    expect(periods.length).toBeGreaterThan(1);
    expect(points.length).toBeLessThanOrEqual(20);
    expect(points.at(-1)![0]).toBe(rows.at(-1)!.sampledAt);
  });

  it("caps a dense series that has a carry-in row and readings stamped after now", () => {
    const rows = [
      reading({ sampledAt: sinceMs - 5 * HOUR }),
      ...Array.from({ length: 5_000 }, (_, index) =>
        reading({ sampledAt: sinceMs + index * 7_500, usedPercent: (index % 2) * 2 }),
      ),
    ];
    const points = toHistoryPeriods(rows, { ...options, maxPoints: 50 }).flatMap(
      (period) => period.points,
    );
    expect(points.length).toBeLessThanOrEqual(50);
    expect(points[0]![0]).toBe(sinceMs - 5 * HOUR);
  });
});
