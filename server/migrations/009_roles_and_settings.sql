-- Roles: an admin can switch the model every user talks to. Everyone starts as a user; only the admin
-- console (`hearth users role <user> admin`) grants it, never the web app.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));

-- Server-wide settings shared by every hearth process (api and worker read the same file). One row per
-- key, the value as JSON. First user: the active model (see server/active-model.ts).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
