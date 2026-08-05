/**
 * End-to-end test: a run leaves the main checkout untouched.
 *
 * Issue #109, acceptance criterion 1. Follows the pattern in git-pipeline.e2e.test.ts.
 *
 * This test:
 * 1. Creates a temp git repo with committed files
 * 2. Spawns a worktree-backed task (via handleSpawnWorker, same as the real flow)
 * 3. Simulates the PreToolUse hook being fired for Write and Read calls targeting the
 *    main checkout — using the exact hook subprocess + env that a real worker launch
 *    would use, rather than shelling out to a full Claude binary
 * 4. Asserts:
 *    (a) main checkout working tree is byte-identical and git status is unchanged
 *    (b) the attempts were denied (hook exits 2, stdout carries {"reason": "..."})
 *    (c) the denial is recorded in .claude/boundary-violations.log in the worktree
 *
 * Regression case: two paths that share a basename but differ only by directory
 * (`app/_layout.tsx` vs `app/(tabs)/_layout.tsx`) — a guard that tests basename
 * alone would pass the first and wrongly allow the second.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

// ── Stubs ──────────────────────────────────────────────────────────────────────

// tmux is stubbed: tests run outside a tmux session and handleSpawnWorker must not
// attempt to spin one up.
vi.mock('../src/spawner/tmux.js', () => ({
  killTmuxWindow: vi.fn(),
  reapStaleWindows: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  createTmuxWindow: vi.fn(() => '@1'),
}))

// ── Imports after mocks ────────────────────────────────────────────────────────

import { createDb, closeDb } from '../src/server/state/db.js'
import { createTask, getTask } from '../src/server/state/tasks.js'
import { upsertProject } from '../src/server/state/projects.js'
import { createRun } from '../src/server/state/runs.js'
import { handleSpawnWorker } from '../src/server/tools/orchestrator.js'
import { buildWorkerSettings, resolveHookCommand } from '../src/spawner/index.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

function initRepo(repoPath: string): void {
  execSync('git init -b main', { cwd: repoPath })
  execSync('git config user.email "e2e@test.com"', { cwd: repoPath })
  execSync('git config user.name "E2E Test"', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# project\n')
  execSync('git add . && git commit -m "init"', { cwd: repoPath })
}

/**
 * Writes settings.local.json to the worktree's .claude/ directory exactly as
 * the real spawner (spawnWorker in src/spawner/index.ts) would before launching
 * a Claude subprocess. This registers the boundary-guard PreToolUse hook.
 */
function writeWorkerSettings(worktreePath: string, repoPath: string): void {
  const claudeDir = join(worktreePath, '.claude')
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(
    join(claudeDir, 'settings.local.json'),
    JSON.stringify(buildWorkerSettings({ worktreePath, repoPath }), null, 2),
  )
}

/**
 * Invokes the boundary-guard PreToolUse hook the way a real worker launch would:
 * - Uses resolveHookCommand() — the exact same function that buildWorkerSettings
 *   embeds into the settings.local.json hooks entry
 * - Sets MULTICLAUDE_WORKTREE and MULTICLAUDE_TASK_ID in the subprocess env
 * - Pipes the JSON payload on stdin (how Claude Code fires a PreToolUse hook)
 */
function invokeGuardHook(
  payload: object,
  worktreePath: string,
  taskId: string,
): { exitCode: number; stdout: string } {
  const hookCmd = resolveHookCommand()
  const input = JSON.stringify(payload).replace(/'/g, "'\\''")
  try {
    const stdout = execSync(`echo '${input}' | ${hookCmd}`, {
      encoding: 'utf-8',
      env: { ...process.env, MULTICLAUDE_WORKTREE: worktreePath, MULTICLAUDE_TASK_ID: taskId },
      timeout: 15000,
    })
    return { exitCode: 0, stdout }
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number }
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? '' }
  }
}

/**
 * SHA-256 over every non-.git file in a directory, sorted by path.
 * Used to detect any mutation to the main checkout's working tree.
 */
function hashWorkingTree(dir: string): string {
  const hash = createHash('sha256')
  const files = execSync(`find "${dir}" -type f ! -path "*/.git/*" | sort`, {
    encoding: 'utf-8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
  for (const f of files) {
    hash.update(f)
    hash.update(readFileSync(f))
  }
  return hash.digest('hex')
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('boundary guard e2e: main checkout stays untouched', () => {
  let db: Database.Database
  let repoPath: string
  let worktreesToClean: string[]

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-boundary-e2e-'))
    worktreesToClean = []
    initRepo(repoPath)
    db = createDb(':memory:')
  })

  afterEach(() => {
    closeDb(db)
    for (const p of worktreesToClean) {
      rmSync(p, { recursive: true, force: true })
    }
    rmSync(repoPath, { recursive: true, force: true })
  })

  it(
    'Write and Read to main checkout are denied; working tree byte-identical before vs after',
    async () => {
      // Commit a sensitive file into the main checkout
      writeFileSync(join(repoPath, 'sensitive.ts'), 'export const apiKey = "secret"\n')
      execSync('git add . && git commit -m "add sensitive"', { cwd: repoPath })

      // Set up a run + task, then create the worktree (same pattern as git-pipeline.e2e.test.ts)
      const project = upsertProject(db, { name: 'boundary-test', cwd: repoPath })
      const run = createRun(db, { project_id: project.id, title: 'Boundary E2E Run' })
      createTask(db, { id: 'task-boundary', title: 'Boundary task', run_id: run.id })

      const spawnResult = await handleSpawnWorker(db, 'task-boundary', 'w-boundary', {
        cwd: repoPath,
      })
      expect(spawnResult.ok).toBe(true)

      const task = getTask(db, 'task-boundary')!
      expect(task.worktree_path).toBeTruthy()
      worktreesToClean.push(task.worktree_path!)

      // Write settings.local.json into the worktree — exactly what the real spawner does
      // before launching the Claude subprocess. This registers the boundary-guard hook.
      writeWorkerSettings(task.worktree_path!, repoPath)

      // ── Snapshot the main checkout BEFORE any hook invocations ────────────────
      const hashBefore = hashWorkingTree(repoPath)
      const statusBefore = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf-8' })

      // ── Simulate a Write tool call targeting the main checkout ────────────────
      const writeResult = invokeGuardHook(
        { tool_name: 'Write', tool_input: { file_path: join(repoPath, 'sensitive.ts'), content: 'hacked!' } },
        task.worktree_path!,
        'task-boundary',
      )
      // (b) Write must be denied — hook exits 2 and emits a reason JSON
      expect(writeResult.exitCode).toBe(2)
      const writeDeny = JSON.parse(writeResult.stdout.trim())
      expect(writeDeny).toHaveProperty('reason')
      expect(typeof writeDeny.reason).toBe('string')
      expect(writeDeny.reason.length).toBeGreaterThan(0)

      // ── Simulate a Read tool call targeting the main checkout ─────────────────
      const readResult = invokeGuardHook(
        { tool_name: 'Read', tool_input: { file_path: join(repoPath, 'sensitive.ts') } },
        task.worktree_path!,
        'task-boundary',
      )
      // (b) Read must also be denied — the guard blocks all out-of-tree file access
      expect(readResult.exitCode).toBe(2)

      // ── (a) Main checkout is byte-identical after the denied attempts ──────────
      const hashAfter = hashWorkingTree(repoPath)
      const statusAfter = execSync('git status --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8',
      })
      expect(hashAfter).toBe(hashBefore)
      expect(statusAfter).toBe(statusBefore)

      // ── (c) Denial is recorded in the worktree's operator-visible log ──────────
      const logPath = join(task.worktree_path!, '.claude', 'boundary-violations.log')
      expect(existsSync(logPath)).toBe(true)
      const logLines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
      // At minimum the Write violation is logged; Read also produces an entry
      expect(logLines.length).toBeGreaterThanOrEqual(1)
      const firstEntry = JSON.parse(logLines[0])
      expect(firstEntry.tool).toBe('Write')
      expect(firstEntry.path).toBe(join(repoPath, 'sensitive.ts'))
      expect(firstEntry.taskId).toBe('task-boundary')
      expect(typeof firstEntry.timestamp).toBe('string')
    },
    30000,
  )

  it(
    'regression: guard rejects both app/_layout.tsx and app/(tabs)/_layout.tsx — basename-only guard fails this test',
    async () => {
      // Commit two files with the SAME basename but different directories into the main checkout.
      // The incident that motivated this test: a worker modified app/(tabs)/_layout.tsx
      // when it was supposed to stay in app/_layout.tsx. A guard that checks basename
      // alone cannot distinguish them.
      mkdirSync(join(repoPath, 'app', '(tabs)'), { recursive: true })
      writeFileSync(join(repoPath, 'app', '_layout.tsx'), 'export default function Root() {}\n')
      writeFileSync(
        join(repoPath, 'app', '(tabs)', '_layout.tsx'),
        'export default function Tabs() {}\n',
      )
      execSync('git add . && git commit -m "add layouts"', { cwd: repoPath })

      // Create run + task + worktree
      const project = upsertProject(db, { name: 'basename-regression', cwd: repoPath })
      const run = createRun(db, { project_id: project.id, title: 'Basename Regression' })
      createTask(db, { id: 'task-basename', title: 'Basename regression task', run_id: run.id })

      const spawnResult = await handleSpawnWorker(db, 'task-basename', 'w-basename', {
        cwd: repoPath,
      })
      expect(spawnResult.ok).toBe(true)

      const task = getTask(db, 'task-basename')!
      worktreesToClean.push(task.worktree_path!)

      // Seed the worktree with the same directory structure — files the worker legitimately owns.
      // A basename-only guard would see these and wrongly allow writes to the same-named files
      // in the main checkout.
      mkdirSync(join(task.worktree_path!, 'app', '(tabs)'), { recursive: true })
      writeFileSync(
        join(task.worktree_path!, 'app', '_layout.tsx'),
        'export default function Root() {}\n',
      )
      writeFileSync(
        join(task.worktree_path!, 'app', '(tabs)', '_layout.tsx'),
        'export default function Tabs() {}\n',
      )

      // Attempt 1: Write to mainCheckout/app/_layout.tsx → must be denied
      const r1 = invokeGuardHook(
        {
          tool_name: 'Write',
          tool_input: { file_path: join(repoPath, 'app', '_layout.tsx'), content: 'hacked!' },
        },
        task.worktree_path!,
        'task-basename',
      )
      expect(r1.exitCode).toBe(2)

      // Attempt 2: Write to mainCheckout/app/(tabs)/_layout.tsx → must also be denied.
      // A basename-only guard finds worktree/app/(tabs)/_layout.tsx and wrongly allows this.
      const r2 = invokeGuardHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: join(repoPath, 'app', '(tabs)', '_layout.tsx'),
            content: 'hacked!',
          },
        },
        task.worktree_path!,
        'task-basename',
      )
      expect(r2.exitCode).toBe(2)

      // Sanity: writes inside the worktree are still allowed
      const r3 = invokeGuardHook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: join(task.worktree_path!, 'app', '_layout.tsx'),
            content: 'safe update',
          },
        },
        task.worktree_path!,
        'task-basename',
      )
      expect(r3.exitCode).toBe(0)

      // Sanity: reads inside the worktree are allowed
      const r4 = invokeGuardHook(
        {
          tool_name: 'Read',
          tool_input: { file_path: join(task.worktree_path!, 'app', '(tabs)', '_layout.tsx') },
        },
        task.worktree_path!,
        'task-basename',
      )
      expect(r4.exitCode).toBe(0)
    },
    30000,
  )
})
