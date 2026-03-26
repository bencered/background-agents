CREATE TABLE IF NOT EXISTS repo_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL,       -- 'linear' (extensible for future integrations)
  source_type TEXT NOT NULL,          -- 'team' | 'project'
  source_id TEXT NOT NULL,            -- Linear team/project UUID
  source_name TEXT NOT NULL,          -- Human-readable name (for UI display)
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  label_filter TEXT,                  -- optional: only match if issue has this label
  is_default INTEGER DEFAULT 0,       -- default repo when multiple match (BOOLEAN in SQLite)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(integration_id, source_type, source_id, repo_owner, repo_name)
);
