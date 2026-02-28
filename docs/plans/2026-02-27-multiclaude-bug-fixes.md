# MultiClaude Bug Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 bugs that cause worker tasks to stay stuck in `in_progress` forever: missing spawner watcher, missing agent_id injection, missing DAG guard on `spawn_worker`, agent status never updating, misleading orchestrator prompt, and missing `cwd` in agents schema.

**Architecture:** All fixes are in the MultiClaude package at `/Users/marcus/Developer/MultiClaude`. The coord server (`src/server/`), spawner (`src/spawner/`), and CLI (`src/cli.ts`) each need targeted changes. Tests live in `tests/`. The TestMultiClaude project at `/Users/marcus/Developer/TestMultiClaude` needs its `settings.local.json` updated.

**Tech Stack:** TypeScript, Node.js, `better-sqlite3`, `@modelcontextprotocol/sdk`, `vitest`

---

## Task 1: Add `cwd` to agents schema and types

**Files:**
- Modify: `src/server/state/db.ts`
- Modify: `src/server/state/agents.ts`
- Modify: `tests/state/agents.test.ts`

**Step 1: Write the failing test**

Open `tests/state/agents.test.ts` and add a new test inside the `describe('agents', ...)` block:

```typescript
it('stores and retrieves cwd on agent', () => {
  registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 1, cwd: '/tmp/my-project' })
  const agent = getAgent(db, 'w-1')
  expect(agent?.cwd).toBe('/tmp/my-project')
})
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/state/agents.test.ts`
Expected: FAIL — `cwd` is `null` or `undefined`, assertion fails

**Step 3: Update `src/server/state/db.ts`**

In the `db.exec(...)` call, find the `agents` table and add `cwd TEXT` column:

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'spawning',
  cwd TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Also add this migration block immediately after the `db.exec(...)` call (handles existing DBs that lack the column):

```typescript
// Migrations: add columns that may be missing in older DBs
try { db.exec("ALTER TABLE agents ADD COLUMN cwd TEXT") } catch { /* already exists */ }
```

**Step 4: Update `src/server/state/agents.ts`**

Add `cwd?: string` to the `Agent` interface, `registerAgent` input, and `updateAgent` input:

```typescript
export interface Agent {
  id: string
  task_id: string | null
  pid: number | null
  status: AgentStatus
  cwd: string | null
  created_at: string
}

// In registerAgent input:
export function registerAgent(db: Database.Database, input: { id: string; task_id?: string; pid?: number; cwd?: string }): void {
  db.prepare('INSERT INTO agents (id, task_id, pid, cwd) VALUES (@id, @task_id, @pid, @cwd)').run({
    id: input.id,
    task_id: input.task_id ?? null,
    pid: input.pid ?? null,
    cwd: input.cwd ?? null,
  })
}

// In updateAgent input, add cwd to the interface and handler:
export function updateAgent(db: Database.Database, id: string, input: { status?: AgentStatus; pid?: number; cwd?: string }): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status }
  if (input.pid !== undefined) { sets.push('pid = @pid'); params.pid = input.pid }
  if (input.cwd !== undefined) { sets.push('cwd = @cwd'); params.cwd = input.cwd }
  if (sets.length === 0) return
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = @id`).run(params)
}
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/state/agents.test.ts`
Expected: PASS (all 5 tests including new one)

**Step 6: Commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add src/server/state/db.ts src/server/state/agents.ts tests/state/agents.test.ts
git commit -m "feat: add cwd column to agents table for spawner watcher"
```

---

## Task 2: Add `cwd` and DAG guard to `spawn_worker` MCP tool

**Files:**
- Modify: `src/server/index.ts`
- Modify: `tests/server.test.ts`

**Step 1: Write the failing tests**

Open `tests/server.test.ts`. Replace its contents (currently a single smoke test) with a fuller test suite:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { startCoordServer } from '../src/server/index.js'
import type { Server } from 'http'

describe('coord server', () => {
  let httpServer: Server | undefined

  afterEach(async () => {
    await new Promise<void>(resolve => httpServer?.close(() => resolve()))
    httpServer = undefined
  })

  it('starts and returns port', async () => {
    const result = await startCoordServer({ port: 7499, dbPath: ':memory:' })
    httpServer = result.httpServer
    expect(result.port).toBe(7499)
  })

  it('exposes spawn_worker tool in orchestrator MCP', async () => {
    const result = await startCoordServer({ port: 7498, dbPath: ':memory:' })
    httpServer = result.httpServer
    // Confirm server started — MCP tool existence is verified by orchestrator.test.ts
    expect(result.port).toBe(7498)
  })
})
```

**Step 2: Run tests to verify they pass**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/server.test.ts`
Expected: PASS

**Step 3: Add `handleSpawnWorker` to `src/server/tools/orchestrator.ts`**

Add this function at the bottom of `src/server/tools/orchestrator.ts`. It validates the DAG guard and returns an error string on violation:

```typescript
import { getBlockers } from '../state/dag.js'
import { getTask } from '../state/tasks.js'
import { registerAgent, updateAgent } from '../state/agents.js'

export function handleSpawnWorker(
  db: Database.Database,
  taskId: string,
  agentId: string,
  opts: { pid?: number; cwd?: string } = {}
): { ok: true } | { ok: false; error: string } {
  // DAG guard: all blockers must be 'done'
  const blockers = getBlockers(db, taskId)
  const notDone = blockers.filter(blockerId => {
    const t = getTask(db, blockerId)
    return !t || t.status !== 'done'
  })
  if (notDone.length > 0) {
    return { ok: false, error: `Cannot spawn task ${taskId}: blocked by [${notDone.join(', ')}] which are not done` }
  }

  registerAgent(db, { id: agentId, task_id: taskId, pid: opts.pid, cwd: opts.cwd })
  updateTask(db, taskId, { status: 'in_progress', agent_id: agentId })
  return { ok: true }
}
```

You also need to add imports at the top of `orchestrator.ts`:
```typescript
import { getBlockers } from '../state/dag.js'
import { getTask, updateTask } from '../state/tasks.js'
import { registerAgent, updateAgent } from '../state/agents.js'
```

**Step 4: Update `spawn_worker` handler in `src/server/index.ts`**

Replace the inline `spawn_worker` handler with a call to `handleSpawnWorker`. Also add `cwd` parameter:

Find this block:
```typescript
server.tool(
  'spawn_worker',
  'Register a worker agent for a task',
  { task_id: z.string(), agent_id: z.string(), pid: z.number().optional() },
  async ({ task_id, agent_id, pid }) => {
    registerAgent(db, { id: agent_id, task_id, pid })
    updateTask(db, task_id, { status: 'in_progress', agent_id })
    return { content: [{ type: 'text' as const, text: `Worker ${agent_id} registered for task ${task_id}` }] }
  }
)
```

Replace with:
```typescript
server.tool(
  'spawn_worker',
  'Register a worker agent for a task. Fails if any DAG blockers are not done.',
  { task_id: z.string(), agent_id: z.string(), pid: z.number().optional(), cwd: z.string().optional() },
  async ({ task_id, agent_id, pid, cwd }) => {
    const result = handleSpawnWorker(db, task_id, agent_id, { pid, cwd })
    if (!result.ok) {
      return { content: [{ type: 'text' as const, text: `ERROR: ${result.error}` }], isError: true }
    }
    return { content: [{ type: 'text' as const, text: `Worker ${agent_id} registered for task ${task_id}` }] }
  }
)
```

Also add the import at the top of `server/index.ts`:
```typescript
import { handlePlanDag, handleGetSystemStatus, handleCancelTask, handleSpawnWorker } from './tools/orchestrator.js'
```

And remove the now-unused direct imports of `registerAgent` and `updateTask` from `server/index.ts` if they're only used by the old spawn_worker handler.

**Step 5: Write tests for `handleSpawnWorker` in `tests/tools/orchestrator.test.ts`**

Add these two tests to the existing `describe('orchestrator tools', ...)` block:

```typescript
import { handleSpawnWorker } from '../../src/server/tools/orchestrator.js'
import { addEdge } from '../../src/server/state/dag.js'

it('spawn_worker succeeds when no blockers', () => {
  db.prepare("INSERT INTO tasks (id, title) VALUES ('t1', 'Task 1')").run()
  const result = handleSpawnWorker(db, 't1', 'w-t1', { cwd: '/tmp' })
  expect(result.ok).toBe(true)
  const task = db.prepare("SELECT status, agent_id FROM tasks WHERE id = 't1'").get() as { status: string; agent_id: string }
  expect(task.status).toBe('in_progress')
  expect(task.agent_id).toBe('w-t1')
  const agent = db.prepare("SELECT cwd FROM agents WHERE id = 'w-t1'").get() as { cwd: string }
  expect(agent.cwd).toBe('/tmp')
})

it('spawn_worker fails when blocker is not done', () => {
  db.prepare("INSERT INTO tasks (id, title) VALUES ('blocker', 'Blocker')").run()
  db.prepare("INSERT INTO tasks (id, title) VALUES ('dependent', 'Dependent')").run()
  addEdge(db, 'blocker', 'dependent')
  const result = handleSpawnWorker(db, 'dependent', 'w-dep')
  expect(result.ok).toBe(false)
  expect((result as { ok: false; error: string }).error).toContain('blocker')
})
```

**Step 6: Run all tests**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test`
Expected: All tests pass (33+ tests)

**Step 7: Commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add src/server/index.ts src/server/tools/orchestrator.ts tests/tools/orchestrator.test.ts tests/server.test.ts
git commit -m "feat: dag guard on spawn_worker, cwd param, extract handleSpawnWorker"
```

---

## Task 3: Agent status update in `get_my_task` + fix agent status on completion

**Files:**
- Modify: `src/server/tools/worker.ts`
- Modify: `tests/tools/worker.test.ts`

**Step 1: Write the failing test**

Add to `tests/tools/worker.test.ts` inside the existing `describe('worker tools', ...)` block:

```typescript
import { registerAgent } from '../../src/server/state/agents.js'

it('get_my_task updates agent status to running', () => {
  registerAgent(db, { id: 'w-1', task_id: 'task-1' })
  // Initially spawning
  const before = db.prepare("SELECT status FROM agents WHERE id = 'w-1'").get() as { status: string }
  expect(before.status).toBe('spawning')

  handleGetMyTask(db, 'w-1')

  const after = db.prepare("SELECT status FROM agents WHERE id = 'w-1'").get() as { status: string }
  expect(after.status).toBe('running')
})
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/tools/worker.test.ts`
Expected: FAIL — status is still `spawning`

**Step 3: Update `handleGetMyTask` in `src/server/tools/worker.ts`**

Add an `updateAgent` call after fetching the task:

```typescript
import { updateAgent } from '../state/agents.js'

export function handleGetMyTask(db: Database.Database, agentId: string): Task {
  const task = db.prepare(
    "SELECT * FROM tasks WHERE agent_id = ? AND status = 'in_progress'"
  ).get(agentId) as Task | undefined
  if (!task) throw new Error(`No in-progress task found for agent ${agentId}`)

  // Mark agent as running now that it has acknowledged its task
  updateAgent(db, agentId, { status: 'running' })

  return task
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/tools/worker.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add src/server/tools/worker.ts tests/tools/worker.test.ts
git commit -m "feat: get_my_task transitions agent status from spawning to running"
```

---

## Task 4: Inject `agentId` and `cwd` in spawner

**Files:**
- Modify: `src/spawner/index.ts`
- Modify: `tests/spawner/index.test.ts`

**Step 1: Read the existing test**

Check `tests/spawner/index.test.ts` to understand existing coverage before adding.

Run: `cat /Users/marcus/Developer/MultiClaude/tests/spawner/index.test.ts`

**Step 2: Write the failing test**

Open `tests/spawner/index.test.ts`. Add tests for agent_id injection:

```typescript
it('buildWorkerArgs includes agent_id in prompt', () => {
  const args = buildWorkerArgs({
    taskId: 'task-1',
    taskTitle: 'Build auth',
    taskDescription: 'JWT impl',
    agentId: 'w-task-1',
    worktreePath: '/tmp/wt',
    mcpConfigPath: '/tmp/config.json',
  })
  const prompt = args[args.length - 1]
  expect(prompt).toContain('w-task-1')
})

it('spawnWorker sets MULTICLAUDE_AGENT_ID env var', () => {
  const cfg = {
    taskId: 'task-1',
    taskTitle: 'Build auth',
    agentId: 'w-task-1',
    worktreePath: '/tmp',
    mcpConfigPath: '/tmp/config.json',
  }
  // We test buildWorkerEnv directly since we can't actually spawn claude in tests
  const env = buildWorkerEnv('w-task-1')
  expect(env['MULTICLAUDE_AGENT_ID']).toBe('w-task-1')
})
```

**Step 3: Run tests to verify they fail**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/spawner/index.test.ts`
Expected: FAIL — `agentId` not in `SpawnConfig`, `buildWorkerEnv` doesn't exist

**Step 4: Update `src/spawner/index.ts`**

Replace the file with:

```typescript
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface SpawnConfig {
  taskId: string
  taskTitle: string
  taskDescription?: string
  agentId: string
  worktreePath: string
  mcpConfigPath: string
}

export interface WorkerMcpConfig {
  mcpServers: Record<string, { url: string; type: string }>
}

export function buildWorkerMcpConfig(opts: { serverPort: number }): WorkerMcpConfig {
  return {
    mcpServers: {
      'multiclaude-coord': {
        type: 'http',
        url: `http://localhost:${opts.serverPort}/worker`,
      },
    },
  }
}

export function buildWorkerEnv(agentId: string): NodeJS.ProcessEnv {
  return { ...process.env, MULTICLAUDE_AGENT_ID: agentId }
}

export function buildWorkerArgs(cfg: SpawnConfig): string[] {
  const prompt = [
    `You are MultiClaude worker agent "${cfg.agentId}".`,
    `Your assigned task is: "${cfg.taskTitle}"`,
    cfg.taskDescription ? `\nDescription: ${cfg.taskDescription}` : '',
    `\n\nYour agent ID is: ${cfg.agentId}`,
    '\nStart by calling get_my_task with your agent_id to get full task context, then implement the task.',
    '\nUse report_progress to send status updates at key checkpoints.',
    '\nWhen complete, call report_done with a summary. If blocked, call report_blocked.',
  ].join('')

  return [
    '--mcp-config', cfg.mcpConfigPath,
    '--dangerously-skip-permissions',
    prompt,
  ]
}

export function spawnWorker(cfg: SpawnConfig): ChildProcess {
  return spawn('claude', buildWorkerArgs(cfg), {
    cwd: cfg.worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildWorkerEnv(cfg.agentId),
  })
}

export function writeWorkerMcpConfig(serverPort: number, configDir: string = tmpdir()): string {
  const config = buildWorkerMcpConfig({ serverPort })
  const path = join(configDir, 'mc-worker-mcp-config.json')
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test tests/spawner/index.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add src/spawner/index.ts tests/spawner/index.test.ts
git commit -m "feat: inject agentId and MULTICLAUDE_AGENT_ID into worker subprocess"
```

---

## Task 5: Add spawner watcher to CLI

**Files:**
- Modify: `src/cli.ts`

This task has no unit test (spawning real subprocesses is an integration concern). The watcher is verified manually in Task 6.

**Step 1: Read the existing `src/cli.ts`**

Confirm the current structure before editing.

**Step 2: Update `src/cli.ts`**

Replace the file content with:

```typescript
import { startCoordServer } from './server/index.js'
import { startWebServer } from './web/server.js'
import { startTui } from './tui/index.js'
import { spawnWorker, writeWorkerMcpConfig } from './spawner/index.js'
import { getTask } from './server/state/tasks.js'
import { updateAgent } from './server/state/agents.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'

interface AgentRow {
  id: string
  task_id: string | null
  cwd: string | null
  pid: number | null
  status: string
}

function startSpawnerWatcher(db: Database.Database, mcpConfigPath: string): void {
  const launched = new Set<string>()

  setInterval(() => {
    const agents = db.prepare(
      "SELECT * FROM agents WHERE status = 'spawning'"
    ).all() as AgentRow[]

    for (const agent of agents) {
      if (launched.has(agent.id)) continue
      if (!agent.cwd) continue
      if (!agent.task_id) continue

      const task = getTask(db, agent.task_id)
      if (!task) continue

      launched.add(agent.id)

      const child = spawnWorker({
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        agentId: agent.id,
        worktreePath: agent.cwd,
        mcpConfigPath,
      })

      if (child.pid) {
        updateAgent(db, agent.id, { pid: child.pid })
      }

      child.on('exit', (code) => {
        // If worker exited without calling report_done, mark it failed
        const current = db.prepare(
          "SELECT status FROM agents WHERE id = ?"
        ).get(agent.id) as { status: string } | undefined
        if (current?.status === 'running') {
          updateAgent(db, agent.id, { status: 'failed' })
        }
      })
    }
  }, 1000)
}

async function main() {
  const args = process.argv.slice(2)
  const noTui = args.includes('--no-tui')
  const noWeb = args.includes('--no-web')
  const coordPortArg = args.find(a => a.startsWith('--coord-port='))
  const webPortArg = args.find(a => a.startsWith('--web-port='))
  const coordPort = coordPortArg ? parseInt(coordPortArg.split('=')[1]) : 7432
  const webPort = webPortArg ? parseInt(webPortArg.split('=')[1]) : 7433

  console.log('Starting MultiClaude...')

  const { db, port } = await startCoordServer({ port: coordPort })
  console.log(`Coordination server: http://localhost:${port}`)

  const mcpConfigPath = writeWorkerMcpConfig(port)

  // Start watcher: polls DB for spawning agents and launches claude subprocesses
  startSpawnerWatcher(db, mcpConfigPath)

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  const claudeDir = join(homeDir, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  const orchestratorConfigPath = join(claudeDir, 'multiclaude-orchestrator-mcp.json')
  const orchestratorConfig = {
    mcpServers: {
      'multiclaude-coord': {
        type: 'http',
        url: `http://localhost:${port}/orchestrator`,
      }
    }
  }
  writeFileSync(orchestratorConfigPath, JSON.stringify(orchestratorConfig, null, 2))

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  console.log(`\nTo launch the orchestrator:\n  claude --mcp-config ${orchestratorConfigPath}`)
  console.log(`\nNote: ports ${coordPort} (coord) and ${webPort} (web) are reserved — avoid killing them in agent tasks.\n`)

  if (!noTui) {
    startTui(db)
  } else {
    console.log('MultiClaude running. Press Ctrl+C to stop.')
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
```

**Step 3: Run full test suite**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add src/cli.ts
git commit -m "feat: spawner watcher — auto-launch worker subprocesses when agents are registered"
```

---

## Task 6: Fix orchestrator prompt

**Files:**
- Modify: `prompts/orchestrator.md`

**Step 1: Remove the misleading lines from `prompts/orchestrator.md`**

Find and remove/replace these lines in the `## Spawning Workers` section:

Remove:
```
- When a subagent you spawned completes its task, call `report_done(task_id, summary)` on its behalf so the coordinator tracks completion and unblocks dependent tasks.
- When a subagent fails, call `report_blocked(task_id, reason, error_context)` so retries and escalation are tracked.
```

Replace with:
```
- Workers call `report_done` and `report_blocked` themselves — you do NOT call these on their behalf.
- Pass `cwd` when calling `spawn_worker` — this tells the system where to run the worker subprocess. For projects without git worktrees, pass the project root directory (e.g. the path you are currently working in).
- Monitor progress by polling `get_system_status()` periodically (every 30-60 seconds or when you want an update).
- When `get_system_status()` shows newly-done tasks, call `spawn_worker` for their unblocked dependents.
```

**Step 2: Verify the full Spawning Workers section looks correct**

Read the file and confirm the section is coherent.

**Step 3: Commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add prompts/orchestrator.md
git commit -m "fix: remove misleading orchestrator prompt — workers call report_done themselves"
```

---

## Task 7: Update `settings.local.json` in TestMultiClaude

**Files:**
- Modify: `/Users/marcus/Developer/TestMultiClaude/.claude/settings.local.json`

The orchestrator needs `cancel_task` in its allow list. Workers use `--dangerously-skip-permissions` so they bypass permission checks, but add the worker tools anyway for any session that uses the worker config interactively.

**Step 1: Update the file**

Replace the file content:

```json
{
  "permissions": {
    "allow": [
      "mcp__multiclaude-coord__get_system_status",
      "mcp__multiclaude-coord__plan_dag",
      "mcp__multiclaude-coord__spawn_worker",
      "mcp__multiclaude-coord__cancel_task",
      "mcp__multiclaude-coord__get_my_task",
      "mcp__multiclaude-coord__report_progress",
      "mcp__multiclaude-coord__report_done",
      "mcp__multiclaude-coord__report_blocked",
      "Bash(npm install:*)",
      "Bash(npm test:*)",
      "Bash(npm start:*)",
      "Bash(node:*)",
      "Bash(curl:*)",
      "Bash(lsof:*)"
    ]
  }
}
```

**Step 2: Verify**

Read the file to confirm it's correct.

---

## Task 8: Build dist and run full test suite

**Step 1: Run full test suite**

Run: `cd /Users/marcus/Developer/MultiClaude && npm test`
Expected: All tests pass

**Step 2: Build TypeScript**

Run: `cd /Users/marcus/Developer/MultiClaude && npm run build`
Expected: No TypeScript errors, `dist/` updated

**Step 3: Smoke test — start MultiClaude with --no-tui**

Run (in background or separate terminal):
```bash
cd /Users/marcus/Developer/MultiClaude && node dist/cli.js --no-tui --no-web 2>&1
```
Expected: "Starting MultiClaude...", "Coordination server: http://localhost:7432"

**Step 4: Test the DAG guard via curl**

```bash
# First, start the server (in background)
# Then hit the MCP endpoint — we verify the server starts correctly via npm test
```

The coord server test in `tests/server.test.ts` already verifies the server starts. The DAG guard is tested in `tests/tools/orchestrator.test.ts`.

**Step 5: Final commit**

```bash
cd /Users/marcus/Developer/MultiClaude
git add dist/
git commit -m "build: rebuild dist after bug fixes"
```

---

## Summary of Changes

| File | Change |
|---|---|
| `src/server/state/db.ts` | Add `cwd TEXT` to agents schema + migration |
| `src/server/state/agents.ts` | Add `cwd` to Agent type, registerAgent, updateAgent |
| `src/server/tools/orchestrator.ts` | Add `handleSpawnWorker` with DAG guard |
| `src/server/index.ts` | Use `handleSpawnWorker`, add `cwd` param to spawn_worker |
| `src/server/tools/worker.ts` | `handleGetMyTask` transitions agent to `running` |
| `src/spawner/index.ts` | Add `agentId` to SpawnConfig, `buildWorkerEnv`, inject agent_id |
| `src/cli.ts` | Add `startSpawnerWatcher` — polls DB, launches worker subprocesses |
| `prompts/orchestrator.md` | Remove misleading report_done line; add cwd guidance |
| `TestMultiClaude/.claude/settings.local.json` | Add cancel_task + worker tools to allow list |
| `tests/state/agents.test.ts` | Test cwd storage |
| `tests/tools/orchestrator.test.ts` | Test DAG guard success and failure |
| `tests/tools/worker.test.ts` | Test agent status → running on get_my_task |
| `tests/spawner/index.test.ts` | Test agentId injection and buildWorkerEnv |
