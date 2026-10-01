-- How far memory extraction has read each conversation. Messages with a higher id are unread.
ALTER TABLE conversations ADD COLUMN memory_through_message_id INTEGER NOT NULL DEFAULT 0;
