-- Memory recall's own vector (memories.ts): the fact embedded as a document with EmbeddingGemma's task
-- prompt, matched against the message embedded as a search query. Kept apart from `embedding` (raw text),
-- which near-duplicate detection's 0.85 was measured on. NULL until recall first needs it; any change to
-- the wording clears it, whichever code path makes the change.
ALTER TABLE memories ADD COLUMN recall_embedding BLOB;
CREATE TRIGGER memories_recall_embedding_stale AFTER UPDATE OF content ON memories
WHEN NEW.content IS NOT OLD.content
BEGIN
  UPDATE memories SET recall_embedding = NULL WHERE id = NEW.id;
END;
