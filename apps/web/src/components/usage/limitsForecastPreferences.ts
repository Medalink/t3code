import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:usage-limits-forecast:v1";
const LimitsForecastPreferencesSchema = Schema.Struct({
  /** Unset follows the window: a day for 5-hour windows, a week for weekly ones. */
  horizonDays: Schema.optional(Schema.Literals([1, 7, 30])),
  /** Unset means on: the forecast assumes you switch accounts when one runs dry. */
  spillover: Schema.optional(Schema.Boolean),
  /** Manual pool drain in additive % per hour, keyed by `forecastOverrideKey`. */
  drainOverrides: Schema.Record(Schema.String, Schema.Number),
});
export type LimitsForecastPreferences = typeof LimitsForecastPreferencesSchema.Type;

const DEFAULT_PREFERENCES: LimitsForecastPreferences = { drainOverrides: {} };

/** Shared by every provider's forecast; without storage it keeps the defaults. */
export function useLimitsForecastPreferences() {
  return useLocalStorage(STORAGE_KEY, DEFAULT_PREFERENCES, LimitsForecastPreferencesSchema);
}
