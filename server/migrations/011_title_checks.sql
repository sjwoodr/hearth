-- How far the retitle check (retitle.ts) has read: the newest message it saw. A chat is checked again
-- once it has a few messages past this. Existing chats start at 0, so each is checked once.
ALTER TABLE conversations ADD COLUMN title_checked_through_message_id INTEGER NOT NULL DEFAULT 0;
