import {
  displayLimitWindows,
  type LimitHistoryIndex,
  type LimitPool,
  type LimitPoolWindow,
  limitPoolKey,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import {
  DEFAULT_FORECAST_HORIZON_DAYS,
  type ForecastDrain,
  type ForecastOptions,
  forecastPoolWindow,
  formatDrainPerHour,
  type LimitForecast,
} from "@t3tools/shared/usageLimitsForecast";
import { ChevronRightIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { type ForecastChartView, LimitForecastChart } from "./LimitForecastChart";
import { useLimitsForecastPreferences } from "./limitsForecastPreferences";

const DAY = 86_400_000;
const HORIZON_OPTIONS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

const VIEW_OPTIONS: ReadonlyArray<{ readonly value: ForecastChartView; readonly label: string }> = [
  { value: "remaining", label: "Remaining quota" },
  { value: "drain", label: "Drain rate" },
];

const BASIS_HINT: Record<ForecastDrain["basis"], string | null> = {
  fitted: null,
  pace: "estimated from pace since reset",
  manual: "manual rate",
  insufficient: "not enough data to forecast",
};

function overrideKey(driver: LimitPool["driver"], window: LimitPoolWindow): string {
  return `${driver}:${limitPoolKey(driver, window)}`;
}

function windowKey(window: LimitPoolWindow): string {
  return `${window.kind}:${window.id}`;
}

function horizonDaysOf(value: unknown): 1 | 7 | 30 | null {
  return HORIZON_OPTIONS.find((option) => String(option.days) === value)?.days ?? null;
}

interface WindowForecast {
  readonly window: LimitPoolWindow;
  readonly horizonDays: 1 | 7 | 30;
  readonly options: ForecastOptions;
  readonly forecast: LimitForecast;
}

function bindingWindow(forecasts: readonly WindowForecast[]): WindowForecast | undefined {
  const emptying = forecasts.flatMap((entry) =>
    entry.forecast.emptyAt === null ? [] : [{ entry, emptyAt: entry.forecast.emptyAt }],
  );
  const soonest = emptying.toSorted((left, right) => left.emptyAt - right.emptyAt)[0];
  if (soonest) return soonest.entry;
  return forecasts.toSorted(
    (left, right) =>
      left.forecast.remainingPercent / left.forecast.capacityPercent -
      right.forecast.remainingPercent / right.forecast.capacityPercent,
  )[0];
}

function nextRefill(entry: WindowForecast): { at: number; restoresPercent: number } | null {
  if (entry.forecast.nextReset) return entry.forecast.nextReset;
  const reset = entry.window.resets.find(
    (candidate) => remainingPercent(candidate.member.window) < 100,
  );
  return reset
    ? { at: reset.at, restoresPercent: 100 - remainingPercent(reset.member.window) }
    : null;
}

export function PoolForecast({
  pool,
  history,
  now,
  color,
}: {
  readonly pool: LimitPool;
  readonly history: LimitHistoryIndex;
  readonly now: number;
  readonly color: string;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [preferences, setPreferences] = useLimitsForecastPreferences();
  const [pickedWindow, setPickedWindow] = useState<string | null>(null);
  const [view, setView] = useState<ForecastChartView>("remaining");
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const forecasts = useMemo(
    () =>
      displayLimitWindows(pool).map((window): WindowForecast => {
        const horizonDays = preferences.horizonDays ?? DEFAULT_FORECAST_HORIZON_DAYS[window.kind];
        const horizonMs = horizonDays * DAY;
        const options: ForecastOptions = {
          now,
          horizonMs,
          lookbackMs: horizonMs / 3,
          drainOverridePerHour:
            preferences.drainOverrides[overrideKey(pool.driver, window)] ?? null,
          spillover: preferences.spillover ?? true,
        };
        return {
          window,
          horizonDays,
          options,
          forecast: forecastPoolWindow(window, history, options),
        };
      }),
    [pool, history, now, preferences],
  );
  const shownWindow = pickedWindow ?? settingsFor;
  const selected =
    forecasts.find((entry) => windowKey(entry.window) === shownWindow) ?? bindingWindow(forecasts);
  if (!selected) return null;

  const { window, forecast, horizonDays, options } = selected;
  const domain = { from: now - options.lookbackMs, to: now + options.horizonMs };
  const settingsOpen = settingsFor === windowKey(window);
  const hint = BASIS_HINT[forecast.drain.basis];
  const refill = nextRefill(selected);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-semibold tabular-nums" style={{ color }}>
          {forecast.remainingPercent}%
        </span>
        <span className="text-sm text-muted-foreground tabular-nums">
          / {forecast.capacityPercent}% remaining
        </span>
        {"perHour" in forecast.drain ? (
          <span className="text-sm text-foreground tabular-nums">
            ~{formatDrainPerHour(forecast.drain.perHour)} per hour
          </span>
        ) : null}
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        {forecasts.length > 1 ? (
          <span className="ms-auto">
            <Select
              value={windowKey(window)}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                setPickedWindow(value);
                if (settingsFor !== null) setSettingsFor(value);
              }}
            >
              <SelectTrigger
                aria-label="Forecast window"
                size="compact"
                variant="ghost"
                className="w-auto min-w-0"
              >
                <SelectValue>{window.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {forecasts.map((entry) => (
                  <SelectItem key={windowKey(entry.window)} value={windowKey(entry.window)}>
                    {entry.window.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </span>
        ) : null}
      </div>

      <ToggleGroup
        aria-label="Forecast view"
        variant="segmented"
        value={[view]}
        onValueChange={(next) => {
          const value = VIEW_OPTIONS.find((option) => option.value === next[0])?.value;
          if (value) setView(value);
        }}
      >
        {VIEW_OPTIONS.map((option) => (
          <Toggle key={option.value} value={option.value}>
            {option.label}
          </Toggle>
        ))}
      </ToggleGroup>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color }} />
          {view === "remaining" ? "Remaining" : "Drain rate"}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <svg aria-hidden width="14" height="2" className="overflow-visible">
            <line
              x1="0"
              x2="14"
              y1="1"
              y2="1"
              stroke={color}
              strokeWidth="2"
              strokeDasharray="3 2"
            />
          </svg>
          {view === "remaining" ? "Projected" : "Forecast rate"}
        </span>
        <span className="ms-auto flex items-center gap-1 text-muted-foreground">
          Next
          <Select
            value={String(horizonDays)}
            onValueChange={(value) => {
              const days = horizonDaysOf(value);
              if (days) setPreferences((current) => ({ ...current, horizonDays: days }));
            }}
          >
            <SelectTrigger
              aria-label="Forecast horizon"
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>
                {HORIZON_OPTIONS.find((option) => option.days === horizonDays)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {HORIZON_OPTIONS.map((option) => (
                <SelectItem key={option.days} value={String(option.days)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </span>
      </div>

      <LimitForecastChart
        forecast={forecast}
        view={view}
        domain={domain}
        now={now}
        color={color}
        label={`${window.label}: ${forecast.remainingPercent}% of ${forecast.capacityPercent}% remaining${
          "perHour" in forecast.drain
            ? `, draining about ${formatDrainPerHour(forecast.drain.perHour)} per hour`
            : ""
        }`}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {refill ? (
          <span className="text-foreground tabular-nums">
            Next reset +{refill.restoresPercent}% ·{" "}
            {formatUpcomingTimestamp(new Date(refill.at).toISOString(), timestampFormat, now)}
          </span>
        ) : null}
        {forecast.emptyAt !== null ? (
          <span className="text-muted-foreground tabular-nums">
            Runs out{" "}
            {formatUpcomingTimestamp(
              new Date(forecast.emptyAt).toISOString(),
              timestampFormat,
              now,
            )}
          </span>
        ) : null}
        <Button
          variant="ghost-muted"
          size="xs"
          className="ms-auto"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsFor(settingsOpen ? null : windowKey(window))}
        >
          <ChevronRightIcon className={settingsOpen ? "rotate-90" : undefined} aria-hidden />
          Forecast settings
        </Button>
      </div>
      {settingsOpen ? (
        <ForecastSettings
          key={windowKey(window)}
          entry={selected}
          history={history}
          override={options.drainOverridePerHour}
          spillover={options.spillover}
          onOverrideChange={(perHour) =>
            setPreferences((current) => {
              const key = overrideKey(pool.driver, window);
              const { [key]: _cleared, ...rest } = current.drainOverrides;
              return {
                ...current,
                drainOverrides: perHour === null ? rest : { ...rest, [key]: perHour },
              };
            })
          }
          onSpilloverChange={(spillover) =>
            setPreferences((current) => ({ ...current, spillover }))
          }
        />
      ) : null}
    </div>
  );
}

function ForecastSettings({
  entry,
  history,
  override,
  spillover,
  onOverrideChange,
  onSpilloverChange,
}: {
  readonly entry: WindowForecast;
  readonly history: LimitHistoryIndex;
  readonly override: number | null;
  readonly spillover: boolean;
  readonly onOverrideChange: (perHour: number | null) => void;
  readonly onSpilloverChange: (spillover: boolean) => void;
}) {
  const inputId = useId();
  const switchId = useId();
  const [text, setText] = useState(override === null ? "" : String(override));
  const estimate = useMemo(
    () =>
      override === null
        ? entry.forecast.drain
        : forecastPoolWindow(entry.window, history, {
            ...entry.options,
            drainOverridePerHour: null,
          }).drain,
    [entry, history, override],
  );
  return (
    <div className="flex flex-col gap-3 border-t border-border/60 pt-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor={inputId} className="text-foreground">
          Drain per hour
        </label>
        <Input
          id={inputId}
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          size="compact"
          className="w-24"
          placeholder={"perHour" in estimate ? formatDrainPerHour(estimate.perHour) : "%"}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const perHour = Number(next);
            if (next.trim() === "") onOverrideChange(null);
            else if (Number.isFinite(perHour) && perHour >= 0) onOverrideChange(perHour);
          }}
        />
        <span className="text-muted-foreground">
          {"perHour" in estimate
            ? `Estimated ~${formatDrainPerHour(estimate.perHour)} per hour${
                estimate.basis === "pace" ? " from pace since reset" : " from history"
              }.`
            : "Not enough history to estimate yet. Enter how much of the pool you use per hour."}
        </span>
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={override === null}
          onClick={() => {
            setText("");
            onOverrideChange(null);
          }}
        >
          Clear
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          size="sm"
          checked={spillover}
          onCheckedChange={(checked) => onSpilloverChange(checked)}
        />
        <label htmlFor={switchId} className="text-foreground">
          Spread drain across accounts as they run dry
        </label>
      </div>
    </div>
  );
}
