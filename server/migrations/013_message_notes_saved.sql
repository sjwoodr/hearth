-- Whether the model saved its private notes (chat-notes.ts) while writing this reply, so the chat can
-- show "Updated its private notes" on it, also after a reload. Never what the notes say.
ALTER TABLE messages ADD COLUMN notes_saved INTEGER NOT NULL DEFAULT 0;
