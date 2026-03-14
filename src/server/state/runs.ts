import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

export type RunStatus = 'open' | 'closed'

export interface Run {
  id: string
  project_id: string
  title: string
  external_ref: string | null
  status: RunStatus
  created_at: string
}

export interface CreateRunInput {
  project_id: string
  title: string
  external_ref?: string
}

export function createRun(db: Database.Database, input: CreateRunInput): Run {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO runs (id, project_id, title, external_ref)
    VALUES (@id, @project_id, @title, @external_ref)
  `).run({
    id,
    project_id: input.project_id,
    title: input.title,
    external_ref: input.external_ref ?? null,
  })
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run
}

export function getRun(db: Database.Database, id: string): Run | null {
  return (db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined) ?? null
}

export function listRuns(db: Database.Database, project_id?: string): Run[] {
  if (project_id) {
    return db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC').all(project_id) as Run[]
  }
  return db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all() as Run[]
}

export type DerivedRunStatus = 'in_progress' | 'done' | 'failed' | 'pending' | 'empty'

export interface RunWithStats extends Run {
  total_tasks: number
  in_progress_tasks: number
  done_tasks: number
  failed_tasks: number
  total_tokens: number
  first_started_at: string | null
  last_updated_at: string | null
  derived_status: DerivedRunStatus
}

export function listRunsWithStats(db: Database.Database, project_id?: string): RunWithStats[] {
  const where = project_id ? 'WHERE r.project_id = ?' : ''
  const params = project_id ? [project_id] : []
  const rows = db.prepare(`
    SELECT
      r.*,
      COUNT(DISTINCT t.id) AS total_tasks,
      COUNT(DISTINCT CASE WHEN t.status = 'in_progress' THEN t.id END) AS in_progress_tasks,
      COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) AS done_tasks,
      COUNT(DISTINCT CASE WHEN t.status = 'failed' THEN t.id END) AS failed_tasks,
      COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
      MIN(t.started_at) AS first_started_at,
      MAX(t.updated_at) AS last_updated_at
    FROM runs r
    LEFT JOIN tasks t ON t.run_id = r.id
    ${where}
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `).all(...params) as Omit<RunWithStats, 'derived_status'>[]

  return rows.map(row => {
    let derived_status: DerivedRunStatus
    if (row.total_tasks === 0) {
      derived_status = 'empty'
    } else if (row.in_progress_tasks > 0) {
      derived_status = 'in_progress'
    } else if (row.failed_tasks > 0) {
      derived_status = 'failed'
    } else if (row.done_tasks === row.total_tasks) {
      derived_status = 'done'
    } else {
      derived_status = 'pending'
    }
    return { ...row, derived_status }
  })
}
