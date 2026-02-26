import type Database from 'better-sqlite3'
import { createTask, listTasks } from '../state/tasks.js'
import { addEdge, getReadyTasks } from '../state/dag.js'
import { listAgents } from '../state/agents.js'

export interface EpicTask {
  id: string
  title: string
  description?: string
  dependsOn: string[]
}

export interface Epic {
  tasks: EpicTask[]
}

export function handlePlanDag(db: Database.Database, epic: Epic): void {
  for (const t of epic.tasks) {
    createTask(db, { id: t.id, title: t.title, description: t.description })
  }
  for (const t of epic.tasks) {
    for (const dep of t.dependsOn) {
      addEdge(db, dep, t.id)
    }
  }
}

export function handleGetSystemStatus(db: Database.Database): {
  tasks: ReturnType<typeof listTasks>
  agents: ReturnType<typeof listAgents>
  readyTasks: ReturnType<typeof getReadyTasks>
} {
  return {
    tasks: listTasks(db),
    agents: listAgents(db),
    readyTasks: getReadyTasks(db),
  }
}

export function handleCancelTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).run(taskId)
}
