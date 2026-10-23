CREATE TABLE IF NOT EXISTS commands (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, payload_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL, affinity TEXT, state TEXT NOT NULL DEFAULT 'queued',
 owner TEXT, token TEXT, lease_until INTEGER, result_key TEXT, image_key TEXT,
 error TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS command_queue ON commands(client_id,state,affinity,created);
CREATE TABLE IF NOT EXISTS workers (
 id TEXT PRIMARY KEY,client_id TEXT NOT NULL,capacity INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 0,live_json TEXT NOT NULL DEFAULT '[]',heartbeat INTEGER NOT NULL,
 stop_requested INTEGER NOT NULL DEFAULT 0
);
