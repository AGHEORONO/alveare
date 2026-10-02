import Database from 'better-sqlite3';

export type DB = Database.Database;

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    token_hash TEXT NOT NULL UNIQUE,
    is_host INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    last_read_msg_id INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    cwd TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_event_at INTEGER NOT NULL
  );

  CREATE TABLE subagents (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    session_id TEXT,
    agent_type TEXT,
    name TEXT,
    purpose TEXT,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    blocked_from TEXT,
    owner_id TEXT REFERENCES agents(id),
    priority INTEGER NOT NULL DEFAULT 2,
    branch TEXT,
    review_notes TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE task_deps (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    depends_on_id INTEGER NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, depends_on_id)
  );

  CREATE TABLE task_files (
    task_id INTEGER NOT NULL REFERENCES tasks(id),
    pattern TEXT NOT NULL,
    PRIMARY KEY (task_id, pattern)
  );

  CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    pattern TEXT NOT NULL,
    task_id INTEGER REFERENCES tasks(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX claims_agent ON claims(agent_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    from_id TEXT,
    to_kind TEXT NOT NULL,
    to_id TEXT,
    body TEXT NOT NULL,
    task_id INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    agent_id TEXT,
    session_id TEXT,
    subagent_id TEXT,
    kind TEXT NOT NULL,
    path TEXT,
    task_id INTEGER,
    flag TEXT,
    data TEXT
  );
  CREATE INDEX events_ts ON events(ts);
  `,
];

export function openDb(file: string): DB {
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
