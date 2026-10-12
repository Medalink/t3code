import {
  formatDrainPerHour,
  type ForecastPoint,
  type LimitForecast,
} from "@t3tools/shared/usageLimitsForecast";
import { useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";
import { niceScale } from "./usageChartScale";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PLOT_TOP = 8;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_X_TICKS = 6;
const X_TICK_STEPS = [
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  5 * DAY,
  7 * DAY,
];

export type ForecastChartView = "remaining" | "drain";

export interface ForecastChartDomain {
  readonly from: number;
  readonly to: number;
}

interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface ForecastChartGeometry {
  /** One path pair per observed segment, so a gap in readings stays a gap. */
  readonly observed: ReadonlyArray<{
    readonly start: number;
    readonly line: string;
    readonly area: string;
  }>;
  readonly projected: { readonly line: string; readonly area: string } | null;
  readonly current: ChartPoint | null;
  readonly nowX: number;
  readonly yMax: number;
  readonly yTicks: ReadonlyArray<{ readonly value: number; readonly y: number }>;
  readonly xTicks: ReadonlyArray<{ readonly at: number; readonly x: number }>;
  readonly xTickUnit: "hour" | "day";
}

function linePath(points: readonly ChartPoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function areaPath(points: readonly ChartPoint[]): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || points.length < 2) return "";
  return `${linePath(points)} L${last.x.toFixed(2)},${VIEW_HEIGHT} L${first.x.toFixed(2)},${VIEW_HEIGHT} Z`;
}

function drainSteps(series: readonly ForecastPoint[]): ForecastPoint[] {
  const first = series[0];
  const second = series[1];
  if (!first) return [];
  const bucket = second ? second.at - first.at : HOUR;
  return series.flatMap((point) => [
    { at: point.at - bucket, value: point.value },
    { at: point.at, value: point.value },
  ]);
}

/** Steps by calendar date, not 24 h, so a DST change does not drift the labels. */
function timeTicks(domain: ForecastChartDomain) {
  const span = domain.to - domain.from;
  const step = X_TICK_STEPS.find((candidate) => span / candidate <= MAX_X_TICKS) ?? 7 * DAY;
  const cursor = new Date(domain.from);
  const ticks: number[] = [];
  if (step >= DAY) {
    cursor.setHours(0, 0, 0, 0);
    for (; cursor.getTime() <= domain.to; cursor.setDate(cursor.getDate() + step / DAY)) {
      if (cursor.getTime() >= domain.from) ticks.push(cursor.getTime());
    }
    return { ticks, unit: "day" as const };
  }
  const hours = step / HOUR;
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(cursor.getHours() - (cursor.getHours() % hours));
  for (; cursor.getTime() <= domain.to; cursor.setHours(cursor.getHours() + hours)) {
    if (cursor.getTime() >= domain.from) ticks.push(cursor.getTime());
  }
  return { ticks, unit: "hour" as const };
}

/**
 * Everything the chart draws, in view-box units. X is proportional to time
 * over `domain`, so a reset is a vertical edge (two points at one instant)
 * and the projection's slope reads as a rate. Remaining quota spans
 * 0..capacity; the drain view scales to its busiest bucket.
 */
export function forecastChartGeometry(
  forecast: LimitForecast,
  view: ForecastChartView,
  domain: ForecastChartDomain,
  now: number,
): ForecastChartGeometry {
  const span = Math.max(1, domain.to - domain.from);
  const toX = (at: number) => ((at - domain.from) / span) * VIEW_WIDTH;
  const rate = "perHour" in forecast.drain ? forecast.drain.perHour : null;
  const scale =
    view === "remaining"
      ? {
          max: forecast.capacityPercent,
          ticks: [0, 0.25, 0.5, 0.75, 1].map((share) => share * forecast.capacityPercent),
        }
      : niceScale(Math.max(rate ?? 0, ...forecast.drainSeries.map((point) => point.value)), 4);
  const toY = (value: number) =>
    scale.max === 0
      ? VIEW_HEIGHT
      : VIEW_HEIGHT - (Math.min(value, scale.max) / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
  const toPoints = (points: readonly ForecastPoint[]) =>
    points.map((point) => ({ x: toX(point.at), y: toY(point.value) }));

  const observedSeries =
    view === "remaining" ? forecast.observed : [drainSteps(forecast.drainSeries)];
  const observed = observedSeries.flatMap((segment) => {
    const first = segment[0];
    if (!first) return [];
    const points = toPoints(segment);
    return [{ start: first.at, line: linePath(points), area: areaPath(points) }];
  });
  const projectedPoints =
    view === "remaining"
      ? toPoints(forecast.projected)
      : rate === null
        ? []
        : toPoints([
            { at: now, value: rate },
            { at: domain.to, value: rate },
          ]);
  const currentValue = view === "remaining" ? forecast.remainingPercent : rate;
  const { ticks, unit } = timeTicks(domain);
  return {
    observed,
    projected:
      projectedPoints.length > 1
        ? { line: linePath(projectedPoints), area: areaPath(projectedPoints) }
        : null,
    current: currentValue === null ? null : { x: toX(now), y: toY(currentValue) },
    nowX: toX(now),
    yMax: scale.max,
    yTicks: scale.ticks.map((value) => ({ value, y: toY(value) })),
    xTicks: ticks.map((at) => ({ at, x: toX(at) })),
    xTickUnit: unit,
  };
}

function valueOnLine(points: readonly ForecastPoint[], at: number): number | null {
  for (let index = points.length - 1; index > 0; index -= 1) {
    const left = points[index - 1];
    const right = points[index];
    if (left && right && left.at <= at && at <= right.at) {
      return right.at === left.at
        ? right.value
        : left.value + ((right.value - left.value) * (at - left.at)) / (right.at - left.at);
    }
  }
  const only = points[0];
  return points.length === 1 && only && only.at === at ? only.value : null;
}

/** What the hover readout shows at a moment: observed before `now`, projected after. */
export function forecastValueAt(
  forecast: LimitForecast,
  view: ForecastChartView,
  at: number,
  now: number,
): { readonly value: number; readonly projected: boolean } | null {
  if (view === "drain") {
    if (at > now) {
      return "perHour" in forecast.drain
        ? { value: forecast.drain.perHour, projected: true }
        : null;
    }
    const bucket = forecast.drainSeries.find((point) => point.at >= at);
    return bucket ? { value: bucket.value, projected: false } : null;
  }
  if (at > now) {
    const value = valueOnLine(forecast.projected, at);
    return value === null ? null : { value, projected: true };
  }
  for (const segment of forecast.observed) {
    const value = valueOnLine(segment, at);
    if (value !== null) return { value, projected: false };
  }
  return null;
}

const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function formatPercent(value: number, view: ForecastChartView): string {
  return view === "remaining" ? `${Math.round(value)}%` : `${formatDrainPerHour(value)}/h`;
}

export function LimitForecastChart({
  forecast,
  view,
  domain,
  now,
  color,
  label,
}: {
  readonly forecast: LimitForecast;
  readonly view: ForecastChartView;
  readonly domain: ForecastChartDomain;
  readonly now: number;
  readonly color: string;
  readonly label: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const geometry = useMemo(
    () => forecastChartGeometry(forecast, view, domain, now),
    [forecast, view, domain, now],
  );
  const [hover, setHover] = useState<number | null>(null);
  const readout =
    hover === null ? null : { share: hover, at: domain.from + hover * (domain.to - domain.from) };
  const hovered = readout && forecastValueAt(forecast, view, readout.at, now);
  const percentOf = (y: number) => `${(y / VIEW_HEIGHT) * 100}%`;
  const formatTick = (at: number) =>
    geometry.xTickUnit === "day"
      ? DAY_LABEL.format(at)
      : formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, at);
  const formatMoment = (at: number) => {
    const iso = new Date(at).toISOString();
    return at > now
      ? formatUpcomingTimestamp(iso, timestampFormat, now)
      : formatDayAwareTimestamp(iso, timestampFormat, now);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-48 w-10 shrink-0">
          {geometry.yTicks.map((tick) => (
            <span
              key={tick.value}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: percentOf(tick.y) }}
            >
              {formatPercent(tick.value, view)}
            </span>
          ))}
        </div>
        <div
          className="relative h-48 flex-1"
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            if (bounds.width === 0) return;
            setHover(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            className="h-full w-full"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={label}
          >
            {geometry.yTicks.map((tick) => (
              <line
                key={tick.value}
                x1={0}
                x2={VIEW_WIDTH}
                y1={tick.y}
                y2={tick.y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {geometry.observed.map((segment) => (
              <path key={segment.start} d={segment.area} fill={color} fillOpacity={0.16} />
            ))}
            {geometry.projected ? (
              <path d={geometry.projected.area} fill={color} fillOpacity={0.06} />
            ) : null}
            {geometry.observed.map((segment) => (
              <path
                key={segment.start}
                d={segment.line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {geometry.projected ? (
              <path
                d={geometry.projected.line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeDasharray="6 5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <line
              x1={geometry.nowX}
              x2={geometry.nowX}
              y1={0}
              y2={VIEW_HEIGHT}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="2 4"
              className="text-muted-foreground"
              vectorEffect="non-scaling-stroke"
            />
            {hover === null ? null : (
              <line
                x1={hover * VIEW_WIDTH}
                x2={hover * VIEW_WIDTH}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {/* HTML so it stays round under the stretched view box. */}
          {geometry.current ? (
            <span
              aria-hidden
              className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                left: `${(geometry.current.x / VIEW_WIDTH) * 100}%`,
                top: percentOf(geometry.current.y),
                backgroundColor: color,
              }}
            />
          ) : null}
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 ps-1 text-3xs text-muted-foreground"
            style={{ left: `${(geometry.nowX / VIEW_WIDTH) * 100}%` }}
          >
            Now
          </span>
          {readout === null ? null : (
            <div
              className="surface-glass pointer-events-none absolute top-2 z-10 min-w-32 rounded-xl border border-border/50 px-2.5 py-2 text-xs whitespace-nowrap shadow-lg"
              style={{
                left: `${readout.share * 100}%`,
                transform:
                  readout.share > 0.5 ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">{formatMoment(readout.at)}</div>
              {hovered ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {hovered.projected ? "Projected" : view === "remaining" ? "Remaining" : "Drain"}
                  </span>
                  <span className="text-foreground tabular-nums">
                    {formatPercent(hovered.value, view)}
                  </span>
                </div>
              ) : (
                <div className="text-muted-foreground">No reading</div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="relative ms-12 h-4 text-3xs text-muted-foreground">
        {geometry.xTicks.map((tick) => (
          <span
            key={tick.at}
            className="absolute -translate-x-1/2 whitespace-nowrap tabular-nums"
            style={{ left: `${(tick.x / VIEW_WIDTH) * 100}%` }}
          >
            {formatTick(tick.at)}
          </span>
        ))}
      </div>
    </div>
  );
}
