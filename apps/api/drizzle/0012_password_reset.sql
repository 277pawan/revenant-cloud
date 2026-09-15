CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_idx
  ON password_reset_tokens(token_hash);

CREATE TABLE IF NOT EXISTS weekly_digest_log (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  week_key varchar(12) NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, week_key)
);
