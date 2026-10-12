import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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
