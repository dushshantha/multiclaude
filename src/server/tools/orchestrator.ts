import path from 'path'
import { simpleGit } from 'simple-git'
import type Database from 'better-sqlite3'
import { createTask, listTasks, getTask, updateTask } from '../state/tasks.js'
import type { Task } from '../state/tasks.js'
import { addEdge, getReadyTasks, getBlockers } from '../state/dag.js'
import { getAgent, listAgents, registerAgent, updateAgent } from '../state/agents.js'
import { upsertProject, listProjects } from '../state/projects.js'
import { createRun, getRun, listRunsWithStats, RunWithStats } from '../state/runs.js'
import { createWorktree, preflightReconcile, isProtectedBranch } from '../../git/worktree.js'
import { killTmuxWindow, reapStaleWindows, ensureTmuxSession } from '../../spawner/tmux.js'

export const VALID_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortValue = typeof VALID_EFFORT_VALUES[number]

/**
 * Normalise an effort string to a canonical EffortValue.
 * Returns the canonical value, or null when the input is invalid.
 * "extra" is accepted as a legacy alias for "xhigh".
 */
export function normalizeEffort(effort: string): EffortValue | null {
  if (effort === 'extra') return 'xhigh'
  if ((VALID_EFFORT_VALUES as readonly string[]).includes(effort)) return effort as EffortValue
  return null
}

export interface EpicTask {
  id: string
  title: string
  description?: string
  model?: string
  effort?: string
  ticket?: string
  dependsOn: string[]
}

export interface Epic {
  tasks: EpicTask[]
  run_id?: string
  cwd?: string
}

export function handlePlanDag(
  db: Database.Database,
  epic: Epic
): { visualization: string } | { error: string } {
  let run_id = epic.run_id
  if (run_id !== undefined) {
    const run = getRun(db, run_id)
    if (!run) {
      return { error: `run_id '${run_id}' not found` }
    }
  } else if (epic.cwd) {
    const name = path.basename(epic.cwd) || epic.cwd
    const project = upsertProject(db, { name, cwd: epic.cwd })
    const title = epic.tasks[0]?.title ?? 'Unnamed run'
    const run = createRun(db, { project_id: project.id, title })
    run_id = run.id
  }
  for (const t of epic.tasks) {
    let effort: string | undefined = t.effort
    if (effort !== undefined) {
      const normalized = normalizeEffort(effort)
      if (normalized === null) {
        return {
          error: `Invalid effort "${effort}" for task "${t.id}". Valid values: ${VALID_EFFORT_VALUES.join(', ')}. ("extra" is accepted as an alias for "xhigh")`,
        }
      }
      effort = normalized
    }
    createTask(db, { id: t.id, title: t.title, description: t.description, model: t.model, effort, run_id, ticket: t.ticket })
  }
  for (const t of epic.tasks) {
    for (const dep of t.dependsOn) {
      addEdge(db, dep, t.id)
    }
  }
  return { visualization: buildDagVisualization(epic) }
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

/** Task augmented with last_log_at so callers can distinguish working from merely registered. */
export type TaskWithActivity = Task & {
  /** ISO timestamp of the most recent log entry for this task, or null if no logs yet. */
  last_log_at: string | null
}

export interface SystemStatus {
  tasks: TaskWithActivity[]
  agents: ReturnType<typeof listAgents>
  readyTasks: ReturnType<typeof getReadyTasks>
  retriableTasks: TaskWithActivity[]
  runs: ReturnType<typeof listRunsWithStats>
}

/**
 * Enriches tasks with last_log_at from the logs table.
 * A null last_log_at means the agent has produced no log entries yet — it is
 * "merely registered" (spawning) rather than actively working.
 */
export function enrichWithLastLog(db: Database.Database, tasks: ReturnType<typeof listTasks>): TaskWithActivity[] {
  return tasks.map(task => {
    const row = db.prepare(
      'SELECT MAX(created_at) AS last_log FROM logs WHERE task_id = ?'
    ).get(task.id) as { last_log: string | null }
    return { ...task, last_log_at: row.last_log }
  })
}

export function handleGetSystemStatus(db: Database.Database, includeDone = false): SystemStatus {
  const allTasks = listTasks(db)
  const tasks = includeDone ? allTasks : allTasks.filter(t => t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled')
  const retriableTasks = allTasks.filter(t => t.status === 'failed' && t.retry_count < t.max_retries)
  return {
    tasks: enrichWithLastLog(db, tasks),
    agents: listAgents(db),
    readyTasks: getReadyTasks(db),
    retriableTasks: enrichWithLastLog(db, retriableTasks),
    runs: listRunsWithStats(db),
  }
}

/**
 * Block until any task status changes, then return full system status.
 * Polls the DB every second server-side.
 */
export async function handleWaitForEvent(
  db: Database.Database,
  timeoutSeconds = 30,
  includeDone = true,
): Promise<SystemStatus> {
  const deadline = Date.now() + timeoutSeconds * 1000
  const snapshot = () =>
    JSON.stringify(listTasks(db).map(t => ({ id: t.id, status: t.status })))
  const initial = snapshot()

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (snapshot() !== initial) break
  }

  return handleGetSystemStatus(db, includeDone)
}

export function handleCancelTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
  ).run(taskId)
  // Reap the tmux window if one exists for this task's agent
  const task = getTask(db, taskId)
  if (task?.agent_id) {
    const agent = getAgent(db, task.agent_id)
    if (agent?.tmux_pane) killTmuxWindow(agent.tmux_pane)
  }
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
  const task = getTask(db, taskId)
  if (task?.agent_id) {
    updateAgent(db, task.agent_id, { status: 'done' })
  }
}

export async function handleSpawnWorker(
  db: Database.Database,
  taskId: string,
  agentId: string,
  opts: { pid?: number; cwd?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
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

  // Budget guard: if the run has a budget, check cumulative cost
  const task = getTask(db, taskId)
  if (task?.run_id) {
    const run = getRun(db, task.run_id)
    if (run?.budget_usd != null) {
      const runStats = listRunsWithStats(db).find(r => r.id === task.run_id)
      if (runStats && runStats.total_cost_usd >= run.budget_usd) {
        return {
          ok: false,
          error: `Cannot spawn task ${taskId}: run budget of $${run.budget_usd.toFixed(4)} exceeded (current spend: $${runStats.total_cost_usd.toFixed(4)})`,
        }
      }
    }
  }

  let agentCwd = opts.cwd
  if (opts.cwd) {
    upsertProject(db, { name: path.basename(opts.cwd), cwd: opts.cwd })
    // Save repo_path before worktree creation so retry loop can find it even if creation fails.
    updateTask(db, taskId, { repo_path: opts.cwd })
    try {
      let baseBranch: string | undefined
      if (task?.run_id) {
        const runBranch = `mc/run-${task.run_id}`
        const git = simpleGit(opts.cwd)
        const branches = await git.branchLocal()
        if (branches.all.includes(runBranch)) {
          baseBranch = runBranch
        }
      }
      const info = await createWorktree(opts.cwd, taskId, undefined, baseBranch)
      updateTask(db, taskId, { worktree_path: info.path, branch: info.branch, head_sha: info.headSha, repo_path: opts.cwd })
      agentCwd = info.path
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const failureReason = classifyWorktreeError(msg)
      updateTask(db, taskId, { status: 'failed', failure_reason: failureReason, failure_detail: msg })
      return { ok: false, error: `Failed to create worktree for task ${taskId}: ${msg}` }
    }
  }
  registerAgent(db, { id: agentId, task_id: taskId, pid: opts.pid, cwd: agentCwd })
  updateTask(db, taskId, { status: 'in_progress', agent_id: agentId, started_at: new Date().toISOString() })
  return { ok: true }
}

export function handleCreateRun(
  db: Database.Database,
  title: string,
  cwd: string,
  external_ref?: string,
  budget_usd?: number,
): { run_id: string } {
  const name = path.basename(cwd) || cwd
  const project = upsertProject(db, { name, cwd })
  const run = createRun(db, { project_id: project.id, title, external_ref, budget_usd })
  return { run_id: run.id }
}

export function handleListProjects(db: Database.Database) {
  return listProjects(db)
}

export function handleListRuns(db: Database.Database, project_id?: string): RunWithStats[] {
  return listRunsWithStats(db, project_id)
}

/**
 * Maps a worktree creation error message to a stable machine-readable slug.
 * Exported so tests can verify classification without calling handleSpawnWorker.
 */
export function classifyWorktreeError(msg: string): string {
  if (/already exists/i.test(msg) && /branch/i.test(msg)) return 'worktree_branch_exists'
  if (/already registered|checked out at/i.test(msg)) return 'worktree_path_registered'
  return 'worktree_create_failed'
}

export interface RecoverAction {
  action: string
  success: boolean
  detail: string
}

export type RecoverVerdict = 'recovered' | 'unrecoverable' | 'needs_human'

export interface RecoverResult {
  task_id: string
  verdict: RecoverVerdict
  reason?: string
  actions: RecoverAction[]
}

export async function handleRecoverTask(
  db: Database.Database,
  taskId: string,
): Promise<RecoverResult> {
  const task = getTask(db, taskId)
  if (!task) {
    return { task_id: taskId, verdict: 'unrecoverable', reason: 'Task not found', actions: [] }
  }

  if (task.status === 'done' || task.status === 'cancelled') {
    return {
      task_id: taskId,
      verdict: 'unrecoverable',
      reason: `Task is already ${task.status}`,
      actions: [],
    }
  }

  if (task.status === 'in_progress') {
    return {
      task_id: taskId,
      verdict: 'needs_human',
      reason: 'Task is in_progress — cancel it first if recovery is needed',
      actions: [],
    }
  }

  if (task.status === 'pending' && !task.failure_reason && !task.agent_id) {
    return {
      task_id: taskId,
      verdict: 'recovered',
      reason: 'Task is already in a spawnable state',
      actions: [],
    }
  }

  const actions: RecoverAction[] = []
  const failureReason = task.failure_reason

  // --- Phase 1: Targeted environment repairs based on failure_reason ---

  if (failureReason?.startsWith('worktree_')) {
    if (task.repo_path) {
      const branch = task.branch ?? `mc/${taskId}`

      if (isProtectedBranch(branch)) {
        return {
          task_id: taskId,
          verdict: 'needs_human',
          reason: `Branch ${branch} is protected — cannot reconcile without risking data loss`,
          actions,
        }
      }

      try {
        const git = simpleGit(task.repo_path)

        let baseBranch: string | undefined
        if (task.run_id) {
          const runBranch = `mc/run-${task.run_id}`
          const branches = await git.branchLocal()
          if (branches.all.includes(runBranch)) {
            baseBranch = runBranch
          }
        }

        const reconcile = await preflightReconcile(git, branch, baseBranch)
        for (const ra of reconcile.actions) {
          actions.push({ action: `git_reconcile:${ra.type}`, success: true, detail: ra.detail })
        }
        if (reconcile.actions.length === 0) {
          actions.push({ action: 'git_reconcile:noop', success: true, detail: `No git state to clean up for branch ${branch}` })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Refusing to reconcile')) {
          return { task_id: taskId, verdict: 'needs_human', reason: msg, actions }
        }
        actions.push({ action: 'git_reconcile', success: false, detail: `Git reconciliation failed: ${msg}` })
        return {
          task_id: taskId,
          verdict: 'unrecoverable',
          reason: 'Git reconciliation failed — manual cleanup required',
          actions,
        }
      }
    } else {
      actions.push({ action: 'git_reconcile:skip', success: true, detail: 'No repo_path on task — skipping git reconciliation' })
    }
  }

  if (failureReason === 'tmux_window_create_failed') {
    try {
      const sessionName = ensureTmuxSession()
      reapStaleWindows(sessionName, taskId)
      actions.push({ action: 'tmux_reap_stale_windows', success: true, detail: `Reaped stale tmux windows for task ${taskId}` })
    } catch {
      actions.push({ action: 'tmux_reap_stale_windows', success: false, detail: 'Tmux unavailable — window reaping skipped (next spawn will retry)' })
    }
  }

  if (failureReason === 'tmux_session_create_failed') {
    actions.push({ action: 'diagnose', success: true, detail: 'Tmux session creation failed — ensure tmux is installed and accessible' })
  }

  if (failureReason === 'settings_write_failed') {
    actions.push({ action: 'diagnose', success: true, detail: 'Settings file write failed — check filesystem permissions on the worktree directory' })
  }

  // --- Phase 2: Clear stale agent record ---

  if (task.agent_id) {
    const agent = getAgent(db, task.agent_id)
    if (agent) {
      if (agent.tmux_pane) {
        killTmuxWindow(agent.tmux_pane)
        actions.push({ action: 'kill_agent_tmux_window', success: true, detail: `Killed tmux window ${agent.tmux_pane} for agent ${task.agent_id}` })
      }
      if (agent.status !== 'done' && agent.status !== 'failed') {
        updateAgent(db, task.agent_id, { status: 'failed' })
        actions.push({ action: 'mark_agent_failed', success: true, detail: `Marked agent ${task.agent_id} as failed` })
      }
    }
  }

  // --- Phase 3: Reset task to spawnable state ---

  db.prepare(`
    UPDATE tasks SET
      status = 'pending',
      agent_id = NULL,
      failure_reason = NULL,
      failure_detail = NULL,
      worktree_path = NULL,
      branch = NULL,
      head_sha = NULL,
      started_at = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(taskId)
  actions.push({ action: 'reset_task', success: true, detail: `Reset task ${taskId} to pending state` })

  // --- Phase 4: Verdict ---

  if (failureReason === 'tmux_session_create_failed' || failureReason === 'settings_write_failed') {
    const envMsg = failureReason === 'tmux_session_create_failed'
      ? 'Task reset to pending, but tmux session creation previously failed — ensure tmux is available before re-spawning'
      : 'Task reset to pending, but settings file write previously failed — check filesystem permissions before re-spawning'
    return { task_id: taskId, verdict: 'needs_human', reason: envMsg, actions }
  }

  return { task_id: taskId, verdict: 'recovered', actions }
}
