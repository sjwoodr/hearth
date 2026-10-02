-- Images pasted into a chat are never stored. A message keeps only how many it carried and, once
-- the model has described them after its reply, that description (NULL until then, or for good if
-- the server restarted first).
ALTER TABLE messages ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN image_note TEXT;

-- Search covers the descriptions too: rebuild the index with a second column.
DROP TRIGGER messages_fts_insert;
DROP TRIGGER messages_fts_delete;
DROP TRIGGER messages_fts_update;
DROP TABLE messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  image_note,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, content, image_note) VALUES (new.id, new.content, new.image_note);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, image_note) VALUES ('delete', old.id, old.content, old.image_note);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content, image_note ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, image_note) VALUES ('delete', old.id, old.content, old.image_note);
  INSERT INTO messages_fts (rowid, content, image_note) VALUES (new.id, new.content, new.image_note);
END;
