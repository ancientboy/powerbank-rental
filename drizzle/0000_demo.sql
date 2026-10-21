CREATE TABLE demo_state (
 id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
 payload TEXT NOT NULL CHECK (json_valid(payload))
);
