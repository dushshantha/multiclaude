# MultiClaude Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-agent Claude Code orchestration system where a natural-language orchestrator spawns parallel worker agents coordinated through an MCP server, with DAG-based task scheduling, git worktree isolation, and live monitoring.

**Architecture:** An MCP Coordination Server holds all shared state (DAG, task status, agent registry, logs). The orchestrator is a Claude Code instance with privileged MCP tools. Workers are Claude Code subprocesses with worker-scoped MCP tools. A TUI + Web UI provide live monitoring.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`, `better-sqlite3`, `simple-git`, `ink` (TUI), `express` + SSE (Web UI), `vitest`

---

## File Structure

```
MultiClaude/
├── src/
│   ├── server/
│   │   ├── index.ts               # MCP server entry point
│   │   ├── tools/
│   │   │   ├── orchestrator.ts    # Orchestrator-scoped tool handlers
│   │   │   └── worker.ts          # Worker-scoped tool handlers
│   │   └── state/
│   │       ├── db.ts              # SQLite setup & migrations
│   │       ├── tasks.ts           # Task CRUD
│   │       ├── dag.ts             # DAG operations
│   │       └── agents.ts          # Agent registry
│   ├── git/
│   │   ├── worktree.ts            # Worktree create/remove
│   │   └── merge.ts               # Branch merge operations
│   ├── spawner/
│   │   └── index.ts               # Claude Code subprocess spawning
│   ├── tui/
│   │   └── index.tsx              # Ink TUI dashboard
│   ├── web/
│   │   ├── server.ts              # Express + SSE server
│   │   └── public/index.html      # DAG dashboard frontend
│   └── cli.ts                     # `multiclaude` entry point
├── prompts/
│   ├── orchestrator.md            # Orchestrator CLAUDE.md template
│   └── worker.md                  # Worker CLAUDE.md template
├── tests/
│   ├── state/
│   │   ├── tasks.test.ts
│   │   └── dag.test.ts
│   ├── git/
│   │   └── worktree.test.ts
│   ├── spawner/
│   │   └── index.test.ts
│   └── tools/
│       ├── orchestrator.test.ts
│       └── worker.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/cli.ts`

**Step 1: Initialize package.json**

```bash
cd /Users/marcus/Developer/MultiClaude
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install @modelcontextprotocol/sdk better-sqlite3 simple-git ink react express
npm install --save-dev typescript @types/node @types/better-sqlite3 @types/express @types/react vitest tsx
```

**Step 3: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "react"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Write vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

**Step 5: Update package.json scripts**

```json
{
  "scripts": {
    "start": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc"
  },
  "bin": {
    "multiclaude": "./dist/cli.js"
  }
}
```

**Step 6: Create placeholder cli.ts**

```typescript
// src/cli.ts
console.log('MultiClaude starting...')
```

**Step 7: Verify setup**

Run: `npm test`
Expected: "No test files found"

**Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/cli.ts
git commit -m "feat: project scaffold with TypeScript and Vitest"
```

---

## Task 2: State Store — Database Setup

**Files:**
- Create: `src/server/state/db.ts`
- Create: `tests/state/db.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/state/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db'
import Database from 'better-sqlite3'

describe('db', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    closeDb(db)
  })

  it('creates tasks table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain('tasks')
    expect(names).toContain('dag_edges')
    expect(names).toContain('agents')
    expect(names).toContain('logs')
  })

  it('tasks table has required columns', () => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    const names = cols.map(c => c.name)
    expect(names).toContain('id')
    expect(names).toContain('title')
    expect(names).toContain('status')
    expect(names).toContain('retry_count')
    expect(names).toContain('worktree_path')
    expect(names).toContain('branch')
    expect(names).toContain('created_at')
    expect(names).toContain('updated_at')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/state/db.test.ts`
Expected: FAIL — "Cannot find module"

**Step 3: Write implementation**

```typescript
// src/server/state/db.ts
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
  return db
}

export function closeDb(db: Database.Database): void {
  db.close()
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/state/db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/state/db.ts tests/state/db.test.ts
git commit -m "feat: SQLite state store with tasks, dag_edges, agents, logs tables"
```

---

## Task 3: State Store — Task CRUD

**Files:**
- Create: `src/server/state/tasks.ts`
- Create: `tests/state/tasks.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/state/tasks.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db'
import { createTask, getTask, updateTask, listTasks, TaskStatus } from '../../src/server/state/tasks'
import Database from 'better-sqlite3'

describe('tasks', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('creates a task and retrieves it by id', () => {
    createTask(db, { id: 'task-1', title: 'Build auth', description: 'JWT impl' })
    const task = getTask(db, 'task-1')
    expect(task?.id).toBe('task-1')
    expect(task?.title).toBe('Build auth')
    expect(task?.status).toBe('pending')
  })

  it('updates task status', () => {
    createTask(db, { id: 'task-1', title: 'Build auth' })
    updateTask(db, 'task-1', { status: 'in_progress' })
    expect(getTask(db, 'task-1')?.status).toBe('in_progress')
  })

  it('increments retry count', () => {
    createTask(db, { id: 'task-1', title: 'Build auth' })
    updateTask(db, 'task-1', { retry_count: 1 })
    expect(getTask(db, 'task-1')?.retry_count).toBe(1)
  })

  it('lists tasks by status', () => {
    createTask(db, { id: 'task-1', title: 'A' })
    createTask(db, { id: 'task-2', title: 'B' })
    updateTask(db, 'task-2', { status: 'in_progress' })
    const pending = listTasks(db, 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('task-1')
  })

  it('returns null for missing task', () => {
    expect(getTask(db, 'nonexistent')).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/state/tasks.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/server/state/tasks.ts
import Database from 'better-sqlite3'

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'cancelled'

export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  retry_count: number
  max_retries: number
  worktree_path?: string
  branch?: string
  agent_id?: string
  created_at: string
  updated_at: string
}

export interface CreateTaskInput {
  id: string
  title: string
  description?: string
  max_retries?: number
}

export interface UpdateTaskInput {
  status?: TaskStatus
  retry_count?: number
  worktree_path?: string
  branch?: string
  agent_id?: string
}

export function createTask(db: Database.Database, input: CreateTaskInput): void {
  db.prepare(`
    INSERT INTO tasks (id, title, description, max_retries)
    VALUES (@id, @title, @description, @max_retries)
  `).run({
    id: input.id,
    title: input.title,
    description: input.description ?? null,
    max_retries: input.max_retries ?? 3,
  })
}

export function getTask(db: Database.Database, id: string): Task | null {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null
}

export function updateTask(db: Database.Database, id: string, input: UpdateTaskInput): void {
  const sets: string[] = ['updated_at = datetime(\'now\')']
  const params: Record<string, unknown> = { id }

  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status }
  if (input.retry_count !== undefined) { sets.push('retry_count = @retry_count'); params.retry_count = input.retry_count }
  if (input.worktree_path !== undefined) { sets.push('worktree_path = @worktree_path'); params.worktree_path = input.worktree_path }
  if (input.branch !== undefined) { sets.push('branch = @branch'); params.branch = input.branch }
  if (input.agent_id !== undefined) { sets.push('agent_id = @agent_id'); params.agent_id = input.agent_id }

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function listTasks(db: Database.Database, status?: TaskStatus): Task[] {
  if (status) {
    return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at').all(status) as Task[]
  }
  return db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Task[]
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/state/tasks.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/state/tasks.ts tests/state/tasks.test.ts
git commit -m "feat: task CRUD operations"
```

---

## Task 4: DAG Engine

**Files:**
- Create: `src/server/state/dag.ts`
- Create: `tests/state/dag.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/state/dag.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db'
import { createTask } from '../../src/server/state/tasks'
import { addEdge, getBlockers, getReadyTasks, getDependents } from '../../src/server/state/dag'
import Database from 'better-sqlite3'

describe('dag', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    createTask(db, { id: 'a', title: 'API Contract' })
    createTask(db, { id: 'b', title: 'JWT Impl' })
    createTask(db, { id: 'c', title: 'OAuth Impl' })
    createTask(db, { id: 'd', title: 'Tests' })
    // a → b, a → c, b → d, c → d
    addEdge(db, 'a', 'b')
    addEdge(db, 'a', 'c')
    addEdge(db, 'b', 'd')
    addEdge(db, 'c', 'd')
  })

  afterEach(() => { closeDb(db) })

  it('getBlockers returns upstream dependencies', () => {
    expect(getBlockers(db, 'b')).toEqual(['a'])
    expect(getBlockers(db, 'd')).toContain('b')
    expect(getBlockers(db, 'd')).toContain('c')
  })

  it('getReadyTasks returns only tasks with all blockers done', () => {
    // Initially only 'a' is ready (no blockers, pending)
    const ready = getReadyTasks(db)
    expect(ready.map(t => t.id)).toEqual(['a'])
  })

  it('getReadyTasks unblocks b and c when a is done', () => {
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'a'").run()
    const ready = getReadyTasks(db)
    const ids = ready.map(t => t.id)
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(ids).not.toContain('d')
  })

  it('getDependents returns downstream tasks', () => {
    expect(getDependents(db, 'a')).toContain('b')
    expect(getDependents(db, 'a')).toContain('c')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/state/dag.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/server/state/dag.ts
import Database from 'better-sqlite3'
import { Task } from './tasks'

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
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/state/dag.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/state/dag.ts tests/state/dag.test.ts
git commit -m "feat: DAG engine with dependency tracking and ready-task resolution"
```

---

## Task 5: Agent Registry

**Files:**
- Create: `src/server/state/agents.ts`
- Create: `tests/state/agents.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/state/agents.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db'
import { registerAgent, getAgent, updateAgent, listAgents } from '../../src/server/state/agents'
import Database from 'better-sqlite3'

describe('agents', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('registers and retrieves an agent', () => {
    registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 12345 })
    const agent = getAgent(db, 'w-1')
    expect(agent?.id).toBe('w-1')
    expect(agent?.task_id).toBe('task-1')
    expect(agent?.pid).toBe(12345)
    expect(agent?.status).toBe('spawning')
  })

  it('updates agent status', () => {
    registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 12345 })
    updateAgent(db, 'w-1', { status: 'running' })
    expect(getAgent(db, 'w-1')?.status).toBe('running')
  })

  it('lists active agents', () => {
    registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 1 })
    registerAgent(db, { id: 'w-2', task_id: 'task-2', pid: 2 })
    updateAgent(db, 'w-2', { status: 'done' })
    const active = listAgents(db, 'running')
    expect(active).toHaveLength(0)
    updateAgent(db, 'w-1', { status: 'running' })
    expect(listAgents(db, 'running')).toHaveLength(1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/state/agents.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/server/state/agents.ts
import Database from 'better-sqlite3'

export type AgentStatus = 'spawning' | 'running' | 'done' | 'failed'

export interface Agent {
  id: string
  task_id?: string
  pid?: number
  status: AgentStatus
  created_at: string
}

export function registerAgent(db: Database.Database, input: { id: string; task_id?: string; pid?: number }): void {
  db.prepare('INSERT INTO agents (id, task_id, pid) VALUES (@id, @task_id, @pid)').run({
    id: input.id,
    task_id: input.task_id ?? null,
    pid: input.pid ?? null,
  })
}

export function getAgent(db: Database.Database, id: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | null
}

export function updateAgent(db: Database.Database, id: string, input: { status?: AgentStatus; pid?: number }): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status }
  if (input.pid !== undefined) { sets.push('pid = @pid'); params.pid = input.pid }
  if (sets.length === 0) return
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function listAgents(db: Database.Database, status?: AgentStatus): Agent[] {
  if (status) {
    return db.prepare('SELECT * FROM agents WHERE status = ?').all(status) as Agent[]
  }
  return db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Agent[]
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/state/agents.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/state/agents.ts tests/state/agents.test.ts
git commit -m "feat: agent registry CRUD"
```

---

## Task 6: Git — Worktree Manager

**Files:**
- Create: `src/git/worktree.ts`
- Create: `tests/git/worktree.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/git/worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktree, removeWorktree, WorktreeInfo } from '../../src/git/worktree'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('worktree', () => {
  let repoPath: string

  beforeEach(() => {
    // Create a temp git repo for testing
    repoPath = mkdtempSync(join(tmpdir(), 'mc-test-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('creates a worktree with a new branch', async () => {
    const info = await createWorktree(repoPath, 'task-1')
    expect(info.branch).toBe('mc/task-1')
    expect(info.path).toContain('mc-task-1')
    // Verify worktree exists
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).toContain('mc/task-1')
    // Cleanup
    await removeWorktree(repoPath, info)
  })

  it('removes a worktree cleanly', async () => {
    const info = await createWorktree(repoPath, 'task-2')
    await removeWorktree(repoPath, info)
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).not.toContain('mc/task-2')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/git/worktree.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/git/worktree.ts
import { simpleGit } from 'simple-git'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export interface WorktreeInfo {
  path: string
  branch: string
  taskId: string
}

export async function createWorktree(repoPath: string, taskId: string): Promise<WorktreeInfo> {
  const branch = `mc/task-${taskId}`
  const worktreePath = mkdtempSync(join(tmpdir(), `mc-task-${taskId}-`))
  const git = simpleGit(repoPath)
  await git.raw(['worktree', 'add', '-b', branch, worktreePath])
  return { path: worktreePath, branch, taskId }
}

export async function removeWorktree(repoPath: string, info: WorktreeInfo): Promise<void> {
  const git = simpleGit(repoPath)
  await git.raw(['worktree', 'remove', '--force', info.path])
  await git.raw(['branch', '-D', info.branch]).catch(() => {})
  await rm(info.path, { recursive: true, force: true }).catch(() => {})
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/git/worktree.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/worktree.ts tests/git/worktree.test.ts
git commit -m "feat: git worktree create/remove"
```

---

## Task 7: Git — Merge Manager

**Files:**
- Create: `src/git/merge.ts`
- Create: `tests/git/merge.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/git/merge.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mergeWorktreeBranch, ensureIntegrationBranch } from '../../src/git/merge'
import { createWorktree, removeWorktree } from '../../src/git/worktree'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('merge', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-merge-test-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('creates integration branch if it does not exist', async () => {
    await ensureIntegrationBranch(repoPath)
    const branches = execSync('git branch', { cwd: repoPath }).toString()
    expect(branches).toContain('mc/integration')
  })

  it('merges a worktree branch into mc/integration', async () => {
    await ensureIntegrationBranch(repoPath)
    const info = await createWorktree(repoPath, 'task-1')
    // Make a commit in the worktree
    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add feature"', { cwd: info.path })
    await mergeWorktreeBranch(repoPath, info.branch)
    // Verify file is in integration branch
    const files = execSync('git show mc/integration:feature.ts', { cwd: repoPath }).toString()
    expect(files).toContain('export const x = 1')
    await removeWorktree(repoPath, info)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/git/merge.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/git/merge.ts
import { simpleGit } from 'simple-git'

const INTEGRATION_BRANCH = 'mc/integration'

export async function ensureIntegrationBranch(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath)
  const branches = await git.branchLocal()
  if (!branches.all.includes(INTEGRATION_BRANCH)) {
    await git.checkoutBranch(INTEGRATION_BRANCH, 'HEAD')
    await git.checkout((await git.branchLocal()).current)
  }
}

export async function mergeWorktreeBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath)
  const current = (await git.branchLocal()).current
  await git.checkout(INTEGRATION_BRANCH)
  await git.merge([branch, '--no-ff', '-m', `merge: ${branch} into integration`])
  await git.checkout(current)
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/git/merge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/git/merge.ts tests/git/merge.test.ts
git commit -m "feat: git merge manager for integration branch"
```

---

## Task 8: Worker Spawner

**Files:**
- Create: `src/spawner/index.ts`
- Create: `tests/spawner/index.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/spawner/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildWorkerMcpConfig, buildWorkerArgs, SpawnConfig } from '../../src/spawner/index'

describe('spawner', () => {
  it('buildWorkerMcpConfig includes the coord server', () => {
    const config = buildWorkerMcpConfig({ serverPort: 7432 })
    expect(config.mcpServers).toHaveProperty('multiclaude-coord')
    expect(config.mcpServers['multiclaude-coord'].url).toContain('7432')
  })

  it('buildWorkerArgs returns claude invocation with mcp config path', () => {
    const cfg: SpawnConfig = {
      taskId: 'task-1',
      taskTitle: 'Build JWT auth',
      taskDescription: 'Implement JWT refresh token logic',
      worktreePath: '/tmp/mc-task-1',
      mcpConfigPath: '/tmp/mc-worker-config.json',
    }
    const args = buildWorkerArgs(cfg)
    expect(args).toContain('--mcp-config')
    expect(args).toContain('/tmp/mc-worker-config.json')
    expect(args.join(' ')).toContain('Build JWT auth')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/spawner/index.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/spawner/index.ts
import { spawn, ChildProcess } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export interface SpawnConfig {
  taskId: string
  taskTitle: string
  taskDescription?: string
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
        type: 'sse',
        url: `http://localhost:${opts.serverPort}/worker`,
      },
    },
  }
}

export function buildWorkerArgs(cfg: SpawnConfig): string[] {
  const prompt = [
    `Your assigned task is: "${cfg.taskTitle}"`,
    cfg.taskDescription ? `\nDescription: ${cfg.taskDescription}` : '',
    '\nYou have access to multiclaude-coord MCP tools.',
    'Start by calling get_my_task() to get full task context, then implement the task.',
    'Use report_progress() to send status updates.',
    'Use report_done() when complete. Use report_blocked() if you encounter errors.',
  ].join('')

  return [
    '--mcp-config', cfg.mcpConfigPath,
    '--print',
    prompt,
  ]
}

export function spawnWorker(cfg: SpawnConfig): ChildProcess {
  const proc = spawn('claude', buildWorkerArgs(cfg), {
    cwd: cfg.worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  return proc
}

export function writeWorkerMcpConfig(serverPort: number, configDir: string = tmpdir()): string {
  const config = buildWorkerMcpConfig({ serverPort })
  const path = join(configDir, `mc-worker-mcp-config.json`)
  writeFileSync(path, JSON.stringify(config, null, 2))
  return path
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/spawner/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/spawner/index.ts tests/spawner/index.test.ts
git commit -m "feat: worker spawner with MCP config generation"
```

---

## Task 9: MCP Server — Worker Tools

**Files:**
- Create: `src/server/tools/worker.ts`
- Create: `tests/tools/worker.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/tools/worker.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db'
import { createTask, updateTask } from '../../src/server/state/tasks'
import { handleGetMyTask, handleReportProgress, handleReportDone, handleReportBlocked } from '../../src/server/tools/worker'
import Database from 'better-sqlite3'

describe('worker tools', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    createTask(db, { id: 'task-1', title: 'JWT auth', description: 'Build JWT' })
    updateTask(db, 'task-1', { status: 'in_progress', agent_id: 'w-1' })
  })

  afterEach(() => { closeDb(db) })

  it('get_my_task returns task for agent', () => {
    const result = handleGetMyTask(db, 'w-1')
    expect(result.id).toBe('task-1')
    expect(result.title).toBe('JWT auth')
  })

  it('report_progress writes a log entry', () => {
    handleReportProgress(db, 'w-1', 'task-1', 'running tests')
    const log = db.prepare('SELECT * FROM logs WHERE task_id = ?').get('task-1') as { message: string }
    expect(log.message).toBe('running tests')
  })

  it('report_done marks task as done', () => {
    handleReportDone(db, 'task-1', 'JWT auth complete, all tests pass')
    const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string }
    expect(task.status).toBe('done')
  })

  it('report_blocked increments retry_count when under limit', () => {
    const result = handleReportBlocked(db, 'task-1', 'test failure', 'npm test failed')
    expect(result.action).toBe('retry')
    const task = db.prepare('SELECT retry_count FROM tasks WHERE id = ?').get('task-1') as { retry_count: number }
    expect(task.retry_count).toBe(1)
  })

  it('report_blocked returns escalate when retries exhausted', () => {
    updateTask(db, 'task-1', { retry_count: 3 })
    const result = handleReportBlocked(db, 'task-1', 'test failure', 'npm test failed')
    expect(result.action).toBe('escalate')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/tools/worker.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/server/tools/worker.ts
import Database from 'better-sqlite3'
import { getTask, updateTask } from '../state/tasks'
import { Task } from '../state/tasks'

export function handleGetMyTask(db: Database.Database, agentId: string): Task {
  const task = db.prepare('SELECT * FROM tasks WHERE agent_id = ? AND status = ?').get(agentId, 'in_progress') as Task | null
  if (!task) throw new Error(`No in-progress task found for agent ${agentId}`)
  return task
}

export function handleReportProgress(db: Database.Database, agentId: string, taskId: string, message: string): void {
  db.prepare('INSERT INTO logs (task_id, agent_id, level, message) VALUES (?, ?, ?, ?)').run(taskId, agentId, 'info', message)
}

export function handleReportDone(db: Database.Database, taskId: string, summary: string): void {
  updateTask(db, taskId, { status: 'done' })
  db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(taskId, 'info', `DONE: ${summary}`)
}

export function handleReportBlocked(
  db: Database.Database,
  taskId: string,
  reason: string,
  errorContext: string
): { action: 'retry' | 'escalate' } {
  const task = getTask(db, taskId)
  if (!task) throw new Error(`Task ${taskId} not found`)

  db.prepare('INSERT INTO logs (task_id, level, message) VALUES (?, ?, ?)').run(taskId, 'warn', `BLOCKED: ${reason}\n${errorContext}`)

  if (task.retry_count < task.max_retries) {
    updateTask(db, taskId, { retry_count: task.retry_count + 1 })
    return { action: 'retry' }
  }

  updateTask(db, taskId, { status: 'failed' })
  return { action: 'escalate' }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/tools/worker.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/tools/worker.ts tests/tools/worker.test.ts
git commit -m "feat: worker MCP tool handlers"
```

---

## Task 10: MCP Server — Orchestrator Tools

**Files:**
- Create: `src/server/tools/orchestrator.ts`
- Create: `tests/tools/orchestrator.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/tools/orchestrator.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db'
import { handlePlanDag, handleGetSystemStatus, handleCancelTask } from '../../src/server/tools/orchestrator'
import Database from 'better-sqlite3'

describe('orchestrator tools', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('plan_dag creates tasks and edges from epic JSON', () => {
    const epic = {
      tasks: [
        { id: 'a', title: 'API Contract', dependsOn: [] },
        { id: 'b', title: 'JWT Impl', dependsOn: ['a'] },
        { id: 'c', title: 'OAuth Impl', dependsOn: ['a'] },
      ]
    }
    handlePlanDag(db, epic)
    const tasks = db.prepare('SELECT * FROM tasks').all() as { id: string }[]
    expect(tasks).toHaveLength(3)
    const edges = db.prepare('SELECT * FROM dag_edges').all() as { from_task: string, to_task: string }[]
    expect(edges).toHaveLength(2)
    expect(edges.find(e => e.from_task === 'a' && e.to_task === 'b')).toBeTruthy()
  })

  it('get_system_status returns tasks and agents', () => {
    const status = handleGetSystemStatus(db)
    expect(status).toHaveProperty('tasks')
    expect(status).toHaveProperty('agents')
    expect(status).toHaveProperty('readyTasks')
  })

  it('cancel_task marks task as cancelled', () => {
    db.prepare("INSERT INTO tasks (id, title, status) VALUES ('t1', 'test', 'in_progress')").run()
    handleCancelTask(db, 't1')
    const task = db.prepare("SELECT status FROM tasks WHERE id = 't1'").get() as { status: string }
    expect(task.status).toBe('cancelled')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm test tests/tools/orchestrator.test.ts`
Expected: FAIL

**Step 3: Write implementation**

```typescript
// src/server/tools/orchestrator.ts
import Database from 'better-sqlite3'
import { createTask } from '../state/tasks'
import { addEdge, getReadyTasks } from '../state/dag'
import { listTasks } from '../state/tasks'
import { listAgents } from '../state/agents'

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
  db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(taskId)
}
```

**Step 4: Run test to verify it passes**

Run: `npm test tests/tools/orchestrator.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server/tools/orchestrator.ts tests/tools/orchestrator.test.ts
git commit -m "feat: orchestrator MCP tool handlers"
```

---

## Task 11: MCP Coordination Server

**Files:**
- Create: `src/server/index.ts`

**Step 1: Write the implementation**

This wires the MCP SDK to our tool handlers. No unit tests here — the tools are already tested; this is integration wiring.

```typescript
// src/server/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import express from 'express'
import { z } from 'zod'
import Database from 'better-sqlite3'
import { createDb } from './state/db'
import { handleGetMyTask, handleReportProgress, handleReportDone, handleReportBlocked } from './tools/worker'
import { handlePlanDag, handleGetSystemStatus, handleCancelTask } from './tools/orchestrator'
import { registerAgent, updateAgent } from './state/agents'
import { updateTask } from './state/tasks'

export interface CoordServerOptions {
  port?: number
  dbPath?: string
}

export async function startCoordServer(opts: CoordServerOptions = {}): Promise<{ app: express.Application; db: Database.Database; port: number }> {
  const port = opts.port ?? 7432
  const db = createDb(opts.dbPath ?? './multiclaude.db')
  const app = express()

  // Orchestrator MCP server (privileged)
  const orchestratorMcp = new McpServer({ name: 'multiclaude-orchestrator', version: '1.0.0' })

  orchestratorMcp.tool('plan_dag', 'Decompose epic into tasks with DAG dependencies',
    { epic: z.object({ tasks: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().optional(), dependsOn: z.array(z.string()) })) }) },
    async ({ epic }) => {
      handlePlanDag(db, epic)
      return { content: [{ type: 'text', text: 'DAG created successfully' }] }
    }
  )

  orchestratorMcp.tool('get_system_status', 'Get full system status: all tasks, agents, ready queue', {},
    async () => {
      const status = handleGetSystemStatus(db)
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] }
    }
  )

  orchestratorMcp.tool('spawn_worker', 'Register a worker agent for a task',
    { task_id: z.string(), agent_id: z.string(), pid: z.number().optional() },
    async ({ task_id, agent_id, pid }) => {
      registerAgent(db, { id: agent_id, task_id, pid })
      updateTask(db, task_id, { status: 'in_progress', agent_id })
      return { content: [{ type: 'text', text: `Worker ${agent_id} registered for task ${task_id}` }] }
    }
  )

  orchestratorMcp.tool('cancel_task', 'Cancel a task', { task_id: z.string() },
    async ({ task_id }) => {
      handleCancelTask(db, task_id)
      return { content: [{ type: 'text', text: `Task ${task_id} cancelled` }] }
    }
  )

  // Worker MCP server (scoped)
  const workerMcp = new McpServer({ name: 'multiclaude-worker', version: '1.0.0' })

  workerMcp.tool('get_my_task', 'Get your assigned task', { agent_id: z.string() },
    async ({ agent_id }) => {
      const task = handleGetMyTask(db, agent_id)
      return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] }
    }
  )

  workerMcp.tool('report_progress', 'Send a progress update',
    { agent_id: z.string(), task_id: z.string(), message: z.string() },
    async ({ agent_id, task_id, message }) => {
      handleReportProgress(db, agent_id, task_id, message)
      return { content: [{ type: 'text', text: 'Progress logged' }] }
    }
  )

  workerMcp.tool('report_done', 'Signal task completion',
    { task_id: z.string(), summary: z.string() },
    async ({ task_id, summary }) => {
      handleReportDone(db, task_id, summary)
      return { content: [{ type: 'text', text: 'Task marked as done' }] }
    }
  )

  workerMcp.tool('report_blocked', 'Report a failure and request retry or escalation',
    { task_id: z.string(), reason: z.string(), error_context: z.string() },
    async ({ task_id, reason, error_context }) => {
      const result = handleReportBlocked(db, task_id, reason, error_context)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )

  // Mount SSE transports
  const orchestratorTransports: Record<string, SSEServerTransport> = {}
  const workerTransports: Record<string, SSEServerTransport> = {}

  app.get('/orchestrator', async (req, res) => {
    const transport = new SSEServerTransport('/orchestrator/messages', res)
    orchestratorTransports[transport.sessionId] = transport
    await orchestratorMcp.connect(transport)
  })
  app.post('/orchestrator/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string
    await orchestratorTransports[sessionId]?.handlePostMessage(req, res)
  })

  app.get('/worker', async (req, res) => {
    const transport = new SSEServerTransport('/worker/messages', res)
    workerTransports[transport.sessionId] = transport
    await workerMcp.connect(transport)
  })
  app.post('/worker/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string
    await workerTransports[sessionId]?.handlePostMessage(req, res)
  })

  await new Promise<void>(resolve => app.listen(port, resolve))
  return { app, db, port }
}
```

**Step 2: Verify server starts**

```typescript
// Quick smoke test - add to tests/server.test.ts
import { describe, it, expect } from 'vitest'
import { startCoordServer } from '../../src/server/index'

describe('coord server', () => {
  it('starts and returns port', async () => {
    const { port } = await startCoordServer({ port: 7499, dbPath: ':memory:' })
    expect(port).toBe(7499)
  })
})
```

Run: `npm test tests/server.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/server/index.ts tests/server.test.ts
git commit -m "feat: MCP coordination server with orchestrator and worker endpoints"
```

---

## Task 12: TUI Dashboard

**Files:**
- Create: `src/tui/index.tsx`

**Step 1: Write the TUI component**

```tsx
// src/tui/index.tsx
import React, { useState, useEffect } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { Task, listTasks } from '../server/state/tasks'
import { Agent, listAgents } from '../server/state/agents'
import Database from 'better-sqlite3'

interface DashboardProps {
  db: Database.Database
  refreshMs?: number
}

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '■',
  done: '✓',
  failed: '✗',
  cancelled: '–',
}

function Dashboard({ db, refreshMs = 1000 }: DashboardProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const { exit } = useApp()

  useEffect(() => {
    const refresh = () => {
      setTasks(listTasks(db))
      setAgents(listAgents(db))
      const recent = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 5').all() as { message: string; level: string }[]
      setLogs(recent.reverse().map(l => `[${l.level}] ${l.message}`))
    }
    refresh()
    const interval = setInterval(refresh, refreshMs)
    return () => clearInterval(interval)
  }, [db, refreshMs])

  useInput((input) => {
    if (input === 'q') exit()
  })

  const running = tasks.filter(t => t.status === 'in_progress').length
  const done = tasks.filter(t => t.status === 'done').length
  const failed = tasks.filter(t => t.status === 'failed').length

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>MultiClaude  </Text>
        <Text color="blue">■ {running} running  </Text>
        <Text color="green">✓ {done} done  </Text>
        {failed > 0 && <Text color="red">✗ {failed} failed  </Text>}
        <Text dimColor>[q]uit</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>{'TASK'.padEnd(30)} {'STATUS'.padEnd(15)} BRANCH</Text>
        {tasks.map(t => {
          const agent = agents.find(a => a.id === t.agent_id)
          const icon = STATUS_ICONS[t.status] ?? '?'
          const color = t.status === 'done' ? 'green' : t.status === 'failed' ? 'red' : t.status === 'in_progress' ? 'blue' : 'white'
          return (
            <Box key={t.id}>
              <Text color={color}>{icon} {t.title.slice(0, 28).padEnd(29)} </Text>
              <Text color={color}>{t.status.padEnd(14)} </Text>
              <Text dimColor>{t.branch ?? '-'}</Text>
              {t.retry_count > 0 && <Text color="yellow">  ⚠ retry {t.retry_count}/{t.max_retries}</Text>}
            </Box>
          )
        })}
      </Box>

      {logs.length > 0 && (
        <Box flexDirection="column" borderStyle="single" padding={1}>
          <Text bold dimColor>Recent Logs</Text>
          {logs.map((l, i) => <Text key={i} dimColor>{l}</Text>)}
        </Box>
      )}
    </Box>
  )
}

export function startTui(db: Database.Database): void {
  render(<Dashboard db={db} />)
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/tui/index.tsx
git commit -m "feat: Ink TUI dashboard with live task/agent status"
```

---

## Task 13: Web UI

**Files:**
- Create: `src/web/server.ts`
- Create: `src/web/public/index.html`

**Step 1: Write the web server with SSE**

```typescript
// src/web/server.ts
import express from 'express'
import { join } from 'path'
import Database from 'better-sqlite3'
import { listTasks } from '../server/state/tasks'
import { listAgents } from '../server/state/agents'

export function startWebServer(db: Database.Database, port = 3000): void {
  const app = express()
  app.use(express.static(join(__dirname, 'public')))

  app.get('/api/status', (req, res) => {
    res.json({
      tasks: listTasks(db),
      agents: listAgents(db),
      edges: db.prepare('SELECT * FROM dag_edges').all(),
    })
  })

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const send = () => {
      const data = JSON.stringify({
        tasks: listTasks(db),
        agents: listAgents(db),
        edges: db.prepare('SELECT * FROM dag_edges').all(),
      })
      res.write(`data: ${data}\n\n`)
    }

    send()
    const interval = setInterval(send, 1000)
    req.on('close', () => clearInterval(interval))
  })

  app.listen(port, () => {
    console.log(`MultiClaude Web UI: http://localhost:${port}`)
  })
}
```

**Step 2: Write the HTML dashboard**

```html
<!-- src/web/public/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>MultiClaude</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 20px; }
    h1 { color: #7c83fd; }
    .stats { display: flex; gap: 20px; margin-bottom: 20px; }
    .stat { padding: 10px 20px; border-radius: 8px; background: #16213e; }
    .stat.running { border-left: 3px solid #7c83fd; }
    .stat.done { border-left: 3px solid #4ade80; }
    .stat.failed { border-left: 3px solid #f87171; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px; color: #888; border-bottom: 1px solid #333; }
    td { padding: 8px; border-bottom: 1px solid #222; }
    .status-pending { color: #888; }
    .status-in_progress { color: #7c83fd; }
    .status-done { color: #4ade80; }
    .status-failed { color: #f87171; }
    .status-cancelled { color: #555; }
  </style>
</head>
<body>
  <h1>MultiClaude</h1>
  <div class="stats">
    <div class="stat running"><div id="running">0</div><div>Running</div></div>
    <div class="stat done"><div id="done">0</div><div>Done</div></div>
    <div class="stat failed"><div id="failed">0</div><div>Failed</div></div>
  </div>
  <table>
    <thead><tr><th>Task</th><th>Status</th><th>Branch</th><th>Retries</th></tr></thead>
    <tbody id="tasks"></tbody>
  </table>
  <script>
    const es = new EventSource('/api/events')
    es.onmessage = ({ data }) => {
      const { tasks } = JSON.parse(data)
      document.getElementById('running').textContent = tasks.filter(t => t.status === 'in_progress').length
      document.getElementById('done').textContent = tasks.filter(t => t.status === 'done').length
      document.getElementById('failed').textContent = tasks.filter(t => t.status === 'failed').length
      document.getElementById('tasks').innerHTML = tasks.map(t => `
        <tr>
          <td>${t.title}</td>
          <td class="status-${t.status}">${t.status}</td>
          <td>${t.branch || '-'}</td>
          <td>${t.retry_count}/${t.max_retries}</td>
        </tr>
      `).join('')
    }
  </script>
</body>
</html>
```

**Step 3: Commit**

```bash
git add src/web/server.ts src/web/public/index.html
git commit -m "feat: web UI with SSE live updates and task table"
```

---

## Task 14: Orchestrator Prompt

**Files:**
- Create: `prompts/orchestrator.md`

**Step 1: Write the orchestrator system prompt**

```markdown
<!-- prompts/orchestrator.md -->
# MultiClaude Orchestrator

You are the orchestrator for MultiClaude, a multi-agent development system.
You have access to the `multiclaude-coord` MCP server with orchestrator-scoped tools.

## Your Role

You coordinate parallel Claude Code worker agents to implement software epics.
The user will give you epics via natural language, GitHub issues, or design docs.
You decompose, plan, spawn, monitor, and merge.

## On Startup

1. Call `get_system_status()` to see current state.
2. Greet the user and summarize any in-progress work.

## When Given an Epic

1. Decompose into concrete tasks. Each task should be implementable by one agent in one worktree.
2. Identify dependencies between tasks (what must be done before what).
3. Call `plan_dag()` with the full task graph.
4. Call `get_system_status()` to confirm the plan.
5. Present the plan to the user before spawning.
6. Once approved, begin spawning workers for all ready tasks.

## Spawning Workers

- Call `spawn_worker(task_id, agent_id)` for each ready task.
- Agent IDs use format: `w-{task_id}`.
- After spawning, the actual subprocess is managed externally — you just register intent.

## Monitoring

- Periodically call `get_system_status()` to check progress.
- When tasks complete (status: done), call `get_system_status()` to find newly unblocked tasks and spawn workers for them.
- When tasks fail (status: failed), escalate to the user with full context from the logs.

## Interaction Modes

- **Collaborative (default):** Keep the user informed of major events. Ask before merging to main.
- **Uninterrupted:** If the user says "go uninterrupted" or similar, operate silently. Only interrupt for exhausted retries or final merge approval.

## Merge Approval

Always ask the user before merging the `mc/integration` branch to `main`.
Present a summary of what changed.

## Key Principles

- Never start a task before its dependencies are done.
- Prefer worktrees over full clones unless the task is high-risk or touches many files.
- Be concise in status updates. Users don't want walls of text.
- When a worker is stuck after retries, present the error clearly and ask for guidance.
```

**Step 2: Commit**

```bash
git add prompts/orchestrator.md
git commit -m "feat: orchestrator system prompt"
```

---

## Task 15: Worker Prompt

**Files:**
- Create: `prompts/worker.md`

**Step 1: Write the worker system prompt**

```markdown
<!-- prompts/worker.md -->
# MultiClaude Worker Agent

You are a worker agent in the MultiClaude system.
You have access to the `multiclaude-coord` MCP server with worker-scoped tools.

## On Startup

1. Call `get_my_task(agent_id: "<YOUR_AGENT_ID>")` to get your assigned task.
2. Read the task title and description carefully.
3. Begin implementation immediately.

## During Implementation

- Call `report_progress(agent_id, task_id, message)` at meaningful checkpoints:
  - When you understand the task
  - When you start writing code
  - When tests pass
  - When you encounter a significant decision
- Keep progress messages brief (one line).

## When Done

- Run all tests. Ensure they pass.
- Call `report_done(task_id, summary)` with a 1-2 sentence summary of what you built.
- Do NOT push branches — the orchestrator handles merging.

## When Blocked

- Call `report_blocked(task_id, reason, error_context)` with the full error.
- The system will tell you whether to retry or that escalation is in progress.
- If told to retry, re-read the error context and try a different approach.
- Do NOT retry more than once without calling `report_blocked` again.

## Key Principles

- Work only in your assigned worktree. Do not touch other branches.
- Write tests before implementation (TDD).
- Commit frequently with descriptive messages.
- Do not ask the user questions — you work autonomously. If truly ambiguous, document your assumption in a comment and proceed.
```

**Step 2: Commit**

```bash
git add prompts/worker.md
git commit -m "feat: worker agent system prompt"
```

---

## Task 16: CLI Entry Point

**Files:**
- Modify: `src/cli.ts`

**Step 1: Write the full CLI**

```typescript
// src/cli.ts
import { startCoordServer } from './server/index'
import { startWebServer } from './web/server'
import { startTui } from './tui/index'
import { writeWorkerMcpConfig } from './spawner/index'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { readFileSync } from 'fs'

async function main() {
  const args = process.argv.slice(2)
  const noTui = args.includes('--no-tui')
  const noWeb = args.includes('--no-web')
  const coordPort = parseInt(args.find(a => a.startsWith('--coord-port='))?.split('=')[1] ?? '7432')
  const webPort = parseInt(args.find(a => a.startsWith('--web-port='))?.split('=')[1] ?? '3000')

  console.log('Starting MultiClaude...')

  // Start coordination server
  const { db, port } = await startCoordServer({ port: coordPort })
  console.log(`Coordination server: http://localhost:${port}`)

  // Write worker MCP config to ~/.claude/ for workers to pick up
  const mcpConfigPath = writeWorkerMcpConfig(port)

  // Write orchestrator MCP config
  const orchestratorConfig = {
    mcpServers: {
      'multiclaude-coord': {
        type: 'sse',
        url: `http://localhost:${port}/orchestrator`,
      }
    }
  }
  const orchestratorConfigPath = join(process.env.HOME ?? '~', '.claude', 'multiclaude-orchestrator-mcp.json')
  mkdirSync(join(process.env.HOME ?? '~', '.claude'), { recursive: true })
  writeFileSync(orchestratorConfigPath, JSON.stringify(orchestratorConfig, null, 2))

  // Write CLAUDE.md for orchestrator
  const orchestratorPrompt = readFileSync(join(__dirname, '../prompts/orchestrator.md'), 'utf-8')

  if (!noWeb) {
    startWebServer(db, webPort)
    console.log(`Web dashboard: http://localhost:${webPort}`)
  }

  console.log(`\nTo launch the orchestrator:\n  claude --mcp-config ${orchestratorConfigPath}\n`)

  if (!noTui) {
    startTui(db)
  } else {
    console.log('MultiClaude running. Press Ctrl+C to stop.')
  }
}

main().catch(console.error)
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: CLI entry point — starts coord server, web UI, and TUI"
```

---

## Task 17: End-to-End Smoke Test

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 2: Start the system**

Run: `npx tsx src/cli.ts --no-tui`
Expected:
```
Starting MultiClaude...
Coordination server: http://localhost:7432
Web dashboard: http://localhost:3000

To launch the orchestrator:
  claude --mcp-config ~/.claude/multiclaude-orchestrator-mcp.json
```

**Step 3: Verify web UI loads**

Open: `http://localhost:3000`
Expected: Dashboard loads with empty task table

**Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: MultiClaude v0.1 — full orchestration system complete"
```

---

## Summary

| Task | What it builds |
|---|---|
| 1 | Project scaffold (TS, Vitest, deps) |
| 2 | SQLite state store schema |
| 3 | Task CRUD |
| 4 | DAG engine (dependency resolution) |
| 5 | Agent registry |
| 6 | Git worktree manager |
| 7 | Git merge manager |
| 8 | Worker subprocess spawner |
| 9 | Worker MCP tool handlers |
| 10 | Orchestrator MCP tool handlers |
| 11 | MCP coordination server (SSE) |
| 12 | Ink TUI dashboard |
| 13 | Web UI with SSE live updates |
| 14 | Orchestrator system prompt |
| 15 | Worker system prompt |
| 16 | CLI entry point |
| 17 | E2E smoke test |
