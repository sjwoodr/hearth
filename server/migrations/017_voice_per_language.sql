-- Reading aloud has a voice for each language (speech.ts): the model's voices are a language and a
-- gender, and a French one reading English sounds British. NULL is the server's default for that
-- language (HEARTH_SPEECH_VOICE_ENGLISH, HEARTH_SPEECH_VOICE_FRENCH). 016's one voice moves to the
-- language it names. users.voice stays, unread, so the version before this one keeps working while
-- the pods roll over.
ALTER TABLE users ADD COLUMN english_voice TEXT;
ALTER TABLE users ADD COLUMN french_voice TEXT;
UPDATE users SET french_voice = voice WHERE voice LIKE '%-french';
UPDATE users SET english_voice = voice WHERE voice IS NOT NULL AND voice NOT LIKE '%-french';
