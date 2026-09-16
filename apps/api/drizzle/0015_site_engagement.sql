-- Site engagement: distinguish marketing vs app traffic
CREATE TABLE IF NOT EXISTS site_traffic_counters (
  site varchar(32) PRIMARY KEY,
  total_visits integer NOT NULL DEFAULT 0,
  total_hero_views integer NOT NULL DEFAULT 0,
  total_logins integer NOT NULL DEFAULT 0,
  total_registers integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO site_traffic_counters (site)
VALUES ('marketing'), ('app')
ON CONFLICT (site) DO NOTHING;

CREATE TABLE IF NOT EXISTS site_engagement_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site varchar(32) NOT NULL,
  event_type varchar(64) NOT NULL,
  path text,
  visitor_id varchar(64) NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email varchar(255),
  visibility varchar(32) NOT NULL DEFAULT 'visible',
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_engagement_site_created_idx
  ON site_engagement_events (site, created_at DESC);

CREATE INDEX IF NOT EXISTS site_engagement_visitor_idx
  ON site_engagement_events (visitor_id);

CREATE INDEX IF NOT EXISTS site_engagement_event_type_idx
  ON site_engagement_events (event_type, site);
