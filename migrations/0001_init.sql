-- Core memory store. INTEGER ids keep tool I/O short (#42 vs a 36-char UUID);
-- AUTOINCREMENT guarantees ids are never reused, so stale vectors can't alias new rows.
CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT    NOT NULL,
  PRIMARY KEY (tag, memory_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);

-- Keyword index (external-content FTS5) used alongside Vectorize for hybrid recall.
-- It is also immediately consistent, covering the short window before new vectors are queryable.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content = 'memories',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;
