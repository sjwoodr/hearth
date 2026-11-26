-- A "for now" memory that has ended (server/for-now.ts): the last day it held, kept after `until` is
-- cleared so the Memories page can list it under "Ended" until the user keeps, edits or forgets it.
-- It's an ordinary memory meanwhile (recalled when relevant). NULL for every other memory.
ALTER TABLE memories ADD COLUMN ended_on TEXT;
