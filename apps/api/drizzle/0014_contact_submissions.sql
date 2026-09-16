CREATE TABLE IF NOT EXISTS contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(32) NOT NULL,
  name varchar(255) NOT NULL,
  email varchar(255) NOT NULL,
  message text,
  source varchar(64) NOT NULL DEFAULT 'marketing',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_submissions_type_idx ON contact_submissions(type);
CREATE INDEX IF NOT EXISTS contact_submissions_created_idx ON contact_submissions(created_at DESC);
