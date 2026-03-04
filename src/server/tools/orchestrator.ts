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

export function handlePlanDag(db: Database.Database, epic: Epic): string {
  for (const t of epic.tasks) {
    createTask(db, { id: t.id, title: t.title, description: t.description })
  }
  for (const t of epic.tasks) {
    for (const dep of t.dependsOn) {
      addEdge(db, dep, t.id)
    }
  }
  return buildDagVisualization(epic)
}

function buildDagVisualization(epic: Epic): string {
  const taskMap = new Map(epic.tasks.map(t => [t.id, t]))
  const depth = new Map<string, number>()

  function getDepth(id: string): number {
    if (depth.has(id)) return depth.get(id)!
    const task = taskMap.get(id)
    if (!task || task.dependsOn.length === 0) {
      depth.set(id, 0)
      return 0
    }
    const d = Math.max(...task.dependsOn.map(dep => getDepth(dep) + 1))
    depth.set(id, d)
    return d
  }

  for (const t of epic.tasks) getDepth(t.id)

  const waves = new Map<number, EpicTask[]>()
  for (const t of epic.tasks) {
    const d = depth.get(t.id) ?? 0
    if (!waves.has(d)) waves.set(d, [])
    waves.get(d)!.push(t)
  }

  const numWaves = waves.size
  const lines: string[] = [
    `DAG Plan — ${epic.tasks.length} task${epic.tasks.length === 1 ? '' : 's'}, ${numWaves} wave${numWaves === 1 ? '' : 's'}`,
    '',
  ]

  for (const [waveIdx, tasks] of [...waves.entries()].sort(([a], [b]) => a - b)) {
    lines.push(`Wave ${waveIdx + 1}${waveIdx === 0 ? ' (runs immediately)' : ''}`)
    for (const t of tasks) lines.push(`  [${t.id}] ${t.title}`)
    lines.push('')
  }

  const edges = epic.tasks.flatMap(t => t.dependsOn.map(dep => `  ${dep} → ${t.id}`))
  if (edges.length > 0) {
    lines.push('Dependencies')
    lines.push(...edges)
  }

  return lines.join('\n').trimEnd()
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
