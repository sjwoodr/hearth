-- The model's private notes for a chat (chat-notes.ts): a story's plan and culprit, a quiz's answer
-- key, a game's secret, a checklist. The model writes them with the save_notes tool and rereads them
-- on every turn. No web route ever returns them (the owner: "don't want the temptation to peek");
-- only bin/hearth reads them. One row per chat, gone with the chat.
CREATE TABLE chat_notes (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  content         TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
