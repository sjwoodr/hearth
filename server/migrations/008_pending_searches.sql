-- A web search the model asked for, waiting for the user's tap on the card: at most one per chat.
-- Kept here rather than in server memory so it survives a restart and any server process can
-- answer it. `state` is JSON: the prompt so far (with image bytes stripped; images are never
-- stored), the Think decision, and the searches and sources so far for this reply. Rows expire
-- after a day (see PendingSearches).
CREATE TABLE pending_searches (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  query           TEXT    NOT NULL,
  state           TEXT    NOT NULL,
  asked_at        TEXT    NOT NULL
);

CREATE INDEX pending_searches_asked_at ON pending_searches(asked_at);
