import type Database from 'better-sqlite3'
import { createTask, listTasks, getTask, updateTask } from '../state/tasks.js'
import { addEdge, getReadyTasks, getBlockers } from '../state/dag.js'
import { listAgents, registerAgent, updateAgent } from '../state/agents.js'

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

/**
 * Block until any task status changes, then return full system status.
 * Polls the DB every second server-side. The orchestrator calls this once
 * per "wait" instead of hammering get_system_status() in a tight loop.
 */
export async function handleWaitForEvent(
  db: Database.Database,
  timeoutSeconds = 30,
): Promise<ReturnType<typeof handleGetSystemStatus>> {
  const deadline = Date.now() + timeoutSeconds * 1000
  const snapshot = () =>
    JSON.stringify(listTasks(db).map(t => ({ id: t.id, status: t.status })))
  const initial = snapshot()

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (snapshot() !== initial) break
  }

  return handleGetSystemStatus(db)
}

export function handleCancelTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).run(taskId)
}

export function handleCompleteTask(
  db: Database.Database,
  taskId: string,
  summary: string
): void {
  updateTask(db, taskId, { status: 'done' })
  db.prepare(
    'INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)'
  ).run(taskId, 'info', `DONE (orchestrator override): ${summary}`)
  // Mark the associated agent done too so the dashboard reflects correctly
  const task = getTask(db, taskId)
  if (task?.agent_id) {
    updateAgent(db, task.agent_id, { status: 'done' })
  }
}

export function handleSpawnWorker(
  db: Database.Database,
  taskId: string,
  agentId: string,
  opts: { pid?: number; cwd?: string } = {}
): { ok: true } | { ok: false; error: string } {
  // DAG guard: all upstream blockers must be 'done'
  const blockers = getBlockers(db, taskId)
  const notDone = blockers.filter(blockerId => {
    const t = getTask(db, blockerId)
    return !t || t.status !== 'done'
  })
  if (notDone.length > 0) {
    return {
      ok: false,
      error: `Cannot spawn task ${taskId}: blocked by [${notDone.join(', ')}] which are not done`,
    }
  }

  registerAgent(db, { id: agentId, task_id: taskId, pid: opts.pid, cwd: opts.cwd })
  updateTask(db, taskId, { status: 'in_progress', agent_id: agentId })
  return { ok: true }
}
