-- The voice each user's replies are read aloud in (speech.ts), from the speech model's list. NULL is
-- the server's default (HEARTH_SPEECH_VOICE).
ALTER TABLE users ADD COLUMN voice TEXT;
