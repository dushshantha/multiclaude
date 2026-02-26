import type Database from 'better-sqlite3'
import type { Task } from './tasks.js'

export function addEdge(db: Database.Database, fromTask: string, toTask: string): void {
  db.prepare('INSERT OR IGNORE INTO dag_edges (from_task, to_task) VALUES (?, ?)').run(fromTask, toTask)
}

export function getBlockers(db: Database.Database, taskId: string): string[] {
  const rows = db.prepare('SELECT from_task FROM dag_edges WHERE to_task = ?').all(taskId) as { from_task: string }[]
  return rows.map(r => r.from_task)
}

export function getDependents(db: Database.Database, taskId: string): string[] {
  const rows = db.prepare('SELECT to_task FROM dag_edges WHERE from_task = ?').all(taskId) as { to_task: string }[]
  return rows.map(r => r.to_task)
}

export function getReadyTasks(db: Database.Database): Task[] {
  // A task is ready if: status = pending AND all blockers have status = done
  return db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM dag_edges e
      JOIN tasks dep ON dep.id = e.from_task
      WHERE e.to_task = t.id
      AND dep.status != 'done'
    )
    ORDER BY t.created_at
  `).all() as Task[]
}
