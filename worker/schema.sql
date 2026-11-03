CREATE TABLE IF NOT EXISTS playlists(
  ytm_id TEXT PRIMARY KEY, title TEXT, track_count INTEGER,
  tracks TEXT, fetched_at INTEGER, error TEXT);
