-- What hearth calls the user; NULL means fall back to the username.
ALTER TABLE users ADD COLUMN display_name TEXT;
