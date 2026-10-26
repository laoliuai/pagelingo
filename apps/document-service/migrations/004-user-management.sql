CREATE TABLE user_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  target_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('create', 'enable', 'disable', 'reset-password')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_audit_events_target_idx ON user_audit_events(target_id, created_at);

CREATE TABLE rate_limit_windows (
  scope text NOT NULL,
  subject text NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  window_start timestamptz NOT NULL,
  used integer NOT NULL CHECK (used > 0),
  PRIMARY KEY (scope, subject, window_seconds, window_start)
);
CREATE INDEX rate_limit_windows_start_idx ON rate_limit_windows(window_start);
