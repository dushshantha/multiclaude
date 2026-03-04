import Database from 'better-sqlite3'

export function createDb(path: string = './multiclaude.db'): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      worktree_path TEXT,
      branch TEXT,
      agent_id TEXT,
      started_at TEXT,
      duration_seconds REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dag_edges (
      from_task TEXT NOT NULL,
      to_task TEXT NOT NULL,
      PRIMARY KEY (from_task, to_task)
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'spawning',
      cwd TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      agent_id TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  // Migrations: add columns that may be missing in older DBs
  try { db.exec("ALTER TABLE agents ADD COLUMN cwd TEXT") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN duration_seconds REAL") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN input_tokens INTEGER") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN output_tokens INTEGER") } catch { /* already exists */ }
  try { db.exec("ALTER TABLE tasks ADD COLUMN total_tokens INTEGER") } catch { /* already exists */ }
  return db
}

export function closeDb(db: Database.Database): void {
  db.close()
}
