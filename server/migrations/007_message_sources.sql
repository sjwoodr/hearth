-- A reply written after a web search keeps the pages it drew on, as a JSON array of
-- {title, url}. The search results themselves are never stored: the model sees them on that
-- turn only, like images.
ALTER TABLE messages ADD COLUMN sources TEXT;
