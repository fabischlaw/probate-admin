-- RI Probate App PostgreSQL Schema

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  email                TEXT UNIQUE NOT NULL,
  role                 TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login           TIMESTAMPTZ,
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS matter_admin (
  matter_id                  TEXT PRIMARY KEY,
  stage                      TEXT NOT NULL DEFAULT 'PETITION_PREP',
  key_dates                  JSONB NOT NULL DEFAULT '{}',
  notes                      TEXT,
  matter_type_overrides      JSONB NOT NULL DEFAULT '{}',
  task_assignments           JSONB NOT NULL DEFAULT '{}',
  staff                      JSONB NOT NULL DEFAULT '[]',
  custom_notes               TEXT NOT NULL DEFAULT '',
  pending_matter_type_change JSONB,
  saved_matter_type          JSONB,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tasks absent from this table are implicitly "pending"
CREATE TABLE IF NOT EXISTS matter_tasks (
  matter_id       TEXT NOT NULL,
  task_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  previous_status TEXT,
  set_date        TIMESTAMPTZ,
  set_by          TEXT,
  notes           TEXT,
  PRIMARY KEY (matter_id, task_id)
);

CREATE TABLE IF NOT EXISTS flags (
  id              TEXT PRIMARY KEY,
  matter_id       TEXT NOT NULL,
  matter_name     TEXT,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  message         TEXT NOT NULL,
  raised_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_events (
  id             TEXT PRIMARY KEY,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id        TEXT,
  user_name      TEXT,
  user_role      TEXT,
  action         TEXT NOT NULL,
  matter_id      TEXT,
  matter_name    TEXT,
  detail         TEXT,
  previous_value TEXT,
  new_value      TEXT,
  ip_address     TEXT,
  user_agent     TEXT
);

-- Generic key-value store for settings, scan history, alert history, etc.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matter_tasks_matter_id ON matter_tasks (matter_id);
CREATE INDEX IF NOT EXISTS idx_flags_matter_id        ON flags (matter_id);
CREATE INDEX IF NOT EXISTS idx_flags_resolved_at      ON flags (resolved_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_matter_id ON audit_events (matter_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action    ON audit_events (action);
