import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per reporter, account identity, and quota window. `subject` is the
  // reporter as JSON (`{"_tag":"instance",...}` or `{"_tag":"source",...}`).
  // Identity is stored as reported ('' when absent) so clients resolve it with
  // the same rules they apply to live accounts; a sign-in switch is a new row.
  // Email, workspace, and credential fingerprint are what the provider status
  // cache (caches/<instanceId>.json) already writes to disk today.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_limit_series (
      series_id INTEGER PRIMARY KEY,
      subject TEXT NOT NULL,
      driver TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL DEFAULT '',
      credential_fingerprint TEXT NOT NULL DEFAULT '',
      window_kind TEXT NOT NULL,
      window_id TEXT NOT NULL,
      UNIQUE (subject, driver, email, workspace_id, credential_fingerprint, window_kind, window_id)
    )
  `;

  // Readings, written only when their content changes or an hour has passed.
  // Times are epoch ms: the table is range-scanned and bucketed by arithmetic.
  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_limit_samples (
      series_id INTEGER NOT NULL,
      sampled_at INTEGER NOT NULL,
      used_percent REAL NOT NULL,
      resets_at INTEGER,
      PRIMARY KEY (series_id, sampled_at)
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_limit_samples_sampled_at
    ON usage_limit_samples (sampled_at)
  `;
});
