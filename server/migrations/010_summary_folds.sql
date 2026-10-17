-- Each time a chat's oldest messages were folded into its running summary, so the chat can show where
-- it happened. `after_message_id` was the newest message then (the line goes after it); `folded` is how
-- many messages that pass took in.
CREATE TABLE summary_folds (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  after_message_id INTEGER NOT NULL,
  folded           INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX summary_folds_conversation ON summary_folds (conversation_id);
