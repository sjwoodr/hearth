-- Full-text index over message text, kept in sync by triggers. `porter` matches word forms
-- (contest, contesting); remove_diacritics lets "francais" find "français".
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
INSERT INTO messages_fts (rowid, content) SELECT id, content FROM messages;

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
END;
