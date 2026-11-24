-- What each reply drew on, for the lines under it in the chat: `recalled` is a JSON array of the ids of
-- the earlier messages of the chat it looked back on (lookback.ts: the first message of each exchange),
-- `remembered` a JSON array of the ids of the memories recalled for it. Ids only, never text: a memory
-- shows its current wording, and one deleted since isn't shown. NULL when there were none.
ALTER TABLE messages ADD COLUMN recalled TEXT;
ALTER TABLE messages ADD COLUMN remembered TEXT;
