-- Who the assistant is to each user (persona.ts): the name it answers to and a description the user
-- writes (voice, backstory, how it relates to them). Empty means the server's defaults
-- (HEARTH_ASSISTANT_NAME, prompts/system.md alone). Each save keeps the version it replaced.
CREATE TABLE personas (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL DEFAULT '',
  about      TEXT    NOT NULL DEFAULT '',
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE persona_history (
  id       INTEGER PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  about    TEXT    NOT NULL,
  saved_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX persona_history_user ON persona_history(user_id, id);

-- Memories can be about the assistant as well as the user: what the user established about it in
-- chats (a backstory, how they picture it). Existing memories are all about the user.
ALTER TABLE memories ADD COLUMN subject TEXT NOT NULL DEFAULT 'user' CHECK (subject IN ('user', 'assistant'));
