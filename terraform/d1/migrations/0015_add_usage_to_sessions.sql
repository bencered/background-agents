-- Track cumulative token usage and cost per session.
ALTER TABLE sessions ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN total_cost REAL NOT NULL DEFAULT 0;
