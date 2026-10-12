import type { LimitForecast } from "@t3tools/shared/usageLimitsForecast";
import { describe, expect, it } from "vite-plus/test";

import { forecastChartGeometry, forecastValueAt } from "./LimitForecastChart";

const HOUR = 3_600_000;
const now = Date.parse("2026-09-03T12:00:00.000Z");
const domain = { from: now - 10 * HOUR, to: now + 30 * HOUR };

function forecast(overrides: Partial<LimitForecast> = {}): LimitForecast {
  return {
    capacityPercent: 600,
    remainingPercent: 300,
    drain: { basis: "fitted", perHour: 5 },
    observed: [
      [
        { at: now - 10 * HOUR, value: 400 },
        { at: now, value: 300 },
      ],
    ],
    projected: [
      { at: now, value: 300 },
      { at: now + 10 * HOUR, value: 250 },
      { at: now + 10 * HOUR, value: 450 },
      { at: now + 30 * HOUR, value: 350 },
    ],
    drainSeries: [
      { at: now - 5 * HOUR, value: 8 },
      { at: now, value: 12 },
    ],
    nextReset: { at: now + 10 * HOUR, restoresPercent: 200 },
    emptyAt: null,
    ...overrides,
  };
}

function points(path: string): Array<{ x: number; y: number }> {
  return [...path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
}

describe("forecastChartGeometry", () => {
  it("places points in proportion to time, not by index", () => {
    const geometry = forecastChartGeometry(forecast(), "remaining", domain, now);
    expect(geometry.nowX).toBe(240);
    expect(points(geometry.observed[0]!.line).map((point) => point.x)).toEqual([0, 240]);
    expect(points(geometry.projected!.line).map((point) => point.x)).toEqual([240, 480, 480, 960]);
  });

  it("draws a reset as a vertical edge at one instant", () => {
    const [, before, after] = points(
      forecastChartGeometry(forecast(), "remaining", domain, now).projected!.line,
    );
    expect(before!.x).toBe(after!.x);
    expect(after!.y).toBeLessThan(before!.y);
  });

  it("spans remaining quota from zero to the pooled capacity", () => {
    const geometry = forecastChartGeometry(forecast(), "remaining", domain, now);
    expect(geometry.yMax).toBe(600);
    expect(geometry.yTicks.map((tick) => tick.value)).toEqual([0, 150, 300, 450, 600]);
    expect(geometry.yTicks[0]!.y).toBe(260);
    expect(geometry.yTicks.at(-1)!.y).toBe(8);
    expect(geometry.current).toEqual({ x: 240, y: geometry.yTicks[2]!.y });
  });

  it("keeps a gap in readings as separate paths", () => {
    const geometry = forecastChartGeometry(
      forecast({
        observed: [
          [
            { at: now - 10 * HOUR, value: 400 },
            { at: now - 8 * HOUR, value: 390 },
          ],
          [
            { at: now - 2 * HOUR, value: 320 },
            { at: now, value: 300 },
          ],
        ],
      }),
      "remaining",
      domain,
      now,
    );
    expect(geometry.observed).toHaveLength(2);
  });

  it("projects nothing when the drain cannot be estimated", () => {
    const geometry = forecastChartGeometry(
      forecast({ drain: { basis: "insufficient", reason: "noClock" }, projected: [] }),
      "remaining",
      domain,
      now,
    );
    expect(geometry.projected).toBeNull();
    expect(geometry.observed).toHaveLength(1);
  });

  it("draws drain buckets as steps and the forecast rate as a flat line from now", () => {
    const geometry = forecastChartGeometry(forecast(), "drain", domain, now);
    expect(geometry.yMax).toBeGreaterThanOrEqual(12);
    const steps = points(geometry.observed[0]!.line);
    expect(steps.map((point) => point.x)).toEqual([0, 120, 120, 240]);
    expect(steps[0]!.y).toBe(steps[1]!.y);
    const projected = points(geometry.projected!.line);
    expect(projected.map((point) => point.x)).toEqual([240, 960]);
    expect(projected[0]!.y).toBe(projected[1]!.y);
  });
});

describe("forecastValueAt", () => {
  it("reads observed values before now and projected values after", () => {
    expect(forecastValueAt(forecast(), "remaining", now - 5 * HOUR, now)).toEqual({
      value: 350,
      projected: false,
    });
    expect(forecastValueAt(forecast(), "remaining", now + 5 * HOUR, now)).toEqual({
      value: 275,
      projected: true,
    });
  });

  it("reads the restored value on a reset edge", () => {
    expect(forecastValueAt(forecast(), "remaining", now + 10 * HOUR, now)?.value).toBe(450);
  });

  it("has no reading inside a gap", () => {
    const gapped = forecast({
      observed: [
        [
          { at: now - 10 * HOUR, value: 400 },
          { at: now - 8 * HOUR, value: 390 },
        ],
        [{ at: now, value: 300 }],
      ],
    });
    expect(forecastValueAt(gapped, "remaining", now - 4 * HOUR, now)).toBeNull();
    expect(forecastValueAt(gapped, "remaining", now, now)?.value).toBe(300);
  });
});
