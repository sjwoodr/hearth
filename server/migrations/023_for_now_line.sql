-- The "For now" line under a chat's first reply (chat.ts): the ids of the "for now" memories that rode on
-- it (shared/for-now.ts), read back with their current wording like `remembered`. NULL on every other reply.
ALTER TABLE messages ADD COLUMN for_now TEXT;
