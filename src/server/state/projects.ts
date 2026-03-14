import path from 'path'
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

export interface Project {
  id: string
  name: string
  cwd: string
  created_at: string
  last_active_at: string
}

export interface ProjectWithStats extends Project {
  total_tasks: number
  in_progress_tasks: number
  done_tasks: number
  failed_tasks: number
  total_runs: number
  total_tokens: number
}

export interface UpsertProjectInput {
  name: string
  cwd: string
}

export function upsertProject(db: Database.Database, input: UpsertProjectInput): Project {
  const existing = db.prepare('SELECT * FROM projects WHERE cwd = ?').get(input.cwd) as Project | undefined
  if (existing) {
    db.prepare(`
      UPDATE projects SET name = @name, last_active_at = datetime('now') WHERE cwd = @cwd
    `).run({ name: input.name, cwd: input.cwd })
    return db.prepare('SELECT * FROM projects WHERE cwd = ?').get(input.cwd) as Project
  }
  const id = randomUUID()
  db.prepare(`
    INSERT INTO projects (id, name, cwd) VALUES (@id, @name, @cwd)
  `).run({ id, name: input.name, cwd: input.cwd })
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project
}

export function getProject(db: Database.Database, id: string): Project | null {
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined) ?? null
}

export function listProjects(db: Database.Database): ProjectWithStats[] {
  return db.prepare(`
    SELECT
      p.*,
      COUNT(DISTINCT t.id) AS total_tasks,
      COUNT(DISTINCT CASE WHEN t.status = 'in_progress' THEN t.id END) AS in_progress_tasks,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) AS done_tasks,
      COUNT(DISTINCT CASE WHEN t.status = 'failed' THEN t.id END) AS failed_tasks,
      COUNT(DISTINCT r.id) AS total_runs,
      COALESCE(SUM(t.total_tokens), 0) AS total_tokens
    FROM projects p
    LEFT JOIN runs r ON r.project_id = p.id
    LEFT JOIN tasks t ON t.run_id = r.id
    GROUP BY p.id
    ORDER BY p.last_active_at DESC
  `).all() as ProjectWithStats[]
}

/**
 * Backfill projects from agents that have a cwd but no matching project row.
 * Called at server startup to recover from pre-feature agent records.
 */
export function backfillProjectsFromAgents(db: Database.Database): void {
  const agentCwds = db.prepare(
    "SELECT DISTINCT cwd FROM agents WHERE cwd IS NOT NULL AND cwd != ''"
  ).all() as { cwd: string }[]

  for (const { cwd } of agentCwds) {
    const existing = db.prepare('SELECT id FROM projects WHERE cwd = ?').get(cwd)
    if (!existing) {
      upsertProject(db, { name: path.basename(cwd) || cwd, cwd })
    }
  }
}
