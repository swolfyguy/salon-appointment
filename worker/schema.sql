-- Cloudflare D1 schema for a FRESH database.
-- Apply with:  npm run db:init   (remote)  or  npm run db:init:local
-- Existing databases: run the files in worker/migrations/ in order instead.
CREATE TABLE IF NOT EXISTS bookings (
  ref           TEXT PRIMARY KEY,
  barber_id     TEXT NOT NULL,
  requested_any INTEGER NOT NULL DEFAULT 0,
  services      TEXT NOT NULL,            -- JSON array of service ids
  date          TEXT NOT NULL,            -- YYYY-MM-DD in shop local time
  time          REAL NOT NULL,            -- start hour, 24h decimal (13.25 = 1:15pm)
  mins          INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  email         TEXT NOT NULL,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | cancelled
  before_media  TEXT,                     -- JSON array of {id, contentType}
  after_media   TEXT,                     -- JSON array of {id, contentType}
  look_request  TEXT,                     -- what the customer said they wanted
  ai_advice     TEXT,                     -- the suggestion they booked, for the barber
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER,
  cancelled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bookings_day ON bookings (date, barber_id, status);

-- Owner-defined time off (lunch, holidays, training). Managed from admin.html.
CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  barber_id  TEXT NOT NULL,
  date       TEXT NOT NULL,
  start      REAL NOT NULL,
  end        REAL NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_day ON blocks (date, barber_id);

-- Uploaded photos and videos. Bytes live in R2 under media/<id>.
CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,             -- before | after
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

-- AI advisor calls, for rate limiting. Rows older than a day are pruned.
CREATE TABLE IF NOT EXISTS ai_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_calls ON ai_calls (ip, created_at);
