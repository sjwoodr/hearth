-- A running summary of the older part of long chats; messages up to summary_through_message_id
-- are covered by it and no longer sent verbatim.
ALTER TABLE conversations ADD COLUMN summary TEXT;
ALTER TABLE conversations ADD COLUMN summary_through_message_id INTEGER NOT NULL DEFAULT 0;

-- 1 while the title is hearth's own (first message, then model-written); 0 once a person renames it.
ALTER TABLE conversations ADD COLUMN title_is_auto INTEGER NOT NULL DEFAULT 1;
-- Titles that already exist are left alone rather than retitled.
UPDATE conversations SET title_is_auto = 0 WHERE title IS NOT NULL;
