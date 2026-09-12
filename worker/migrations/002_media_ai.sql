-- Migration for databases created before photos and the AI advisor were added.
-- Apply once:  npx wrangler d1 execute salon-appointment --remote --file=worker/migrations/002_media_ai.sql
ALTER TABLE bookings ADD COLUMN before_media TEXT;
ALTER TABLE bookings ADD COLUMN after_media TEXT;
ALTER TABLE bookings ADD COLUMN look_request TEXT;
ALTER TABLE bookings ADD COLUMN ai_advice TEXT;

CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls ON ai_calls (ip, created_at);
