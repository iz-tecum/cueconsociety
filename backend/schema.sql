PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('subscribed','unsubscribed','cleaned','archived','pending')),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  unsubscribe_token_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS contacts_status ON contacts(status);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  preheader TEXT NOT NULL,
  body TEXT NOT NULL,
  recipient_ids_json TEXT NOT NULL CHECK(json_valid(recipient_ids_json)),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS send_campaigns (
  id TEXT PRIMARY KEY,
  snapshot_key TEXT NOT NULL UNIQUE,
  draft_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  from_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staged','running','paused','completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE TABLE IF NOT EXISTS send_jobs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES send_campaigns(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','queued','processing','sent','skipped','retry','needs_review','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  message_id TEXT NOT NULL,
  provider_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id,contact_id)
);
CREATE INDEX IF NOT EXISTS send_jobs_ready ON send_jobs(campaign_id,status,next_attempt_at);
CREATE TABLE IF NOT EXISTS send_budget (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES send_jobs(id),
  attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS send_budget_time ON send_budget(attempted_at);
CREATE TABLE IF NOT EXISTS send_control (
  id TEXT PRIMARY KEY,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER NOT NULL DEFAULT 0,
  verified_principal TEXT,
  verified_from TEXT,
  verified_at TEXT
);
INSERT OR IGNORE INTO send_control(id) VALUES('gmail');
