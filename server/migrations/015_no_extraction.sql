-- A message the user started with "[no extraction]", and the reply to it (shared/no-extraction.ts):
-- never read by memory extraction, the summary or titles, and never in the search index. Set when the
-- message is saved and never changed.
ALTER TABLE messages ADD COLUMN no_extraction INTEGER NOT NULL DEFAULT 0;

-- The index skips them. messages_fts has external content, so a 'delete' must only ever be sent for a
-- row that was indexed: deleting one that wasn't corrupts the index. A later 'rebuild' would index them
-- again from the messages table (search.ts still leaves them out of results): after one, delete them.
DROP TRIGGER messages_fts_insert;
DROP TRIGGER messages_fts_delete;
DROP TRIGGER messages_fts_update;
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN new.no_extraction = 0 BEGIN
  INSERT INTO messages_fts (rowid, content, image_note) VALUES (new.id, new.content, new.image_note);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages WHEN old.no_extraction = 0 BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, image_note) VALUES ('delete', old.id, old.content, old.image_note);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content, image_note ON messages WHEN old.no_extraction = 0 BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, content, image_note) VALUES ('delete', old.id, old.content, old.image_note);
  INSERT INTO messages_fts (rowid, content, image_note) VALUES (new.id, new.content, new.image_note);
END;
