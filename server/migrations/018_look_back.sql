-- Look-back (lookback.ts): the part of a chat folded into its summary, cut into pieces and embedded,
-- so a reply can be given the earlier exchanges that match the newest message. Derived from messages:
-- deleting a message or chat deletes its pieces. `lookback_through_message_id` is how far a chat's
-- folded messages have been indexed (it trails `summary_through_message_id`).
CREATE TABLE message_pieces (
  id              INTEGER PRIMARY KEY,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  text            TEXT    NOT NULL,
  embedding       BLOB    NOT NULL
);
CREATE INDEX message_pieces_conversation ON message_pieces (conversation_id);
CREATE INDEX message_pieces_message ON message_pieces (message_id);

ALTER TABLE conversations ADD COLUMN lookback_through_message_id INTEGER NOT NULL DEFAULT 0;
