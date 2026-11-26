-- "For now" memories (server/for-now.ts): true for days or weeks, then over, like a trip or a visit.
-- `until` is the last day one holds, YYYY-MM-DD in the server's time zone; NULL for lasting memories.
-- Until then it rides on every reply; afterwards it is rewritten in the past tense and `until` cleared.
ALTER TABLE memories ADD COLUMN until TEXT;
