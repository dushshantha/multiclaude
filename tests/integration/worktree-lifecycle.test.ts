import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask } from '../../src/server/state/tasks.js'
import { handleSpawnWorker } from '../../src/server/tools/orchestrator.js'
import { handleReportDone } from '../../src/server/tools/worker.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

interface TaskRow {
  id: string
  status: string
  worktree_path: string | null
  branch: string | null
}

function initRepo(repoPath: string) {
  execSync('git init', { cwd: repoPath })
  execSync('git config user.email "test@test.com"', { cwd: repoPath })
  execSync('git config user.name "Test"', { cwd: repoPath })
  execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
}

describe('worktree lifecycle integration', () => {
  let db: Database.Database
  let repoPath: string
  let worktreesToClean: string[]

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-int-test-'))
    initRepo(repoPath)
    db = createDb(':memory:')
    worktreesToClean = []
  })

  afterEach(() => {
    closeDb(db)
    // Clean up worktrees first (they reference the repo), then the repo
    for (const p of worktreesToClean) {
      rmSync(p, { recursive: true, force: true })
    }
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('happy path: spawn creates worktree, worker commits, report_done merges and removes worktree', async () => {
    createTask(db, { id: 'task-1', title: 'Feature A' })

    // spawn_worker creates worktree and registers agent with cwd
    const spawnResult = await handleSpawnWorker(db, 'task-1', 'w-1', { cwd: repoPath })
    expect(spawnResult.ok).toBe(true)

    // Worktree path and branch are stored on the task
    const task = db.prepare("SELECT * FROM tasks WHERE id = 'task-1'").get() as TaskRow
    expect(task.worktree_path).toBeTruthy()
    expect(task.branch).toBe('mc/task-1')

    const worktreePath = task.worktree_path!
    worktreesToClean.push(worktreePath) // safety cleanup if test fails

    // Simulate worker making a commit inside the worktree
    writeFileSync(join(worktreePath, 'feature.ts'), 'export const feature = true\n')
    execSync('git add . && git commit -m "add feature"', { cwd: worktreePath })

    // report_done merges mc/task-1 into mc/integration and removes worktree
    await handleReportDone(db, 'task-1', 'Feature complete')

    // Task must be done
    const doneTask = db.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }
    expect(doneTask.status).toBe('done')

    // The committed file is visible in mc/integration
    const content = execSync('git show mc/integration:feature.ts', { cwd: repoPath }).toString()
    expect(content).toContain('export const feature = true')

    // Worktree directory was removed
    expect(existsSync(worktreePath)).toBe(false)

    // Merge log entry was written
    const mergeLog = db.prepare(
      "SELECT message FROM logs WHERE task_id = 'task-1' AND message LIKE 'Merged%'"
    ).get() as { message: string } | undefined
    expect(mergeLog?.message).toContain('mc/task-1')
    expect(mergeLog?.message).toContain('mc/integration')
  })

  it('merge conflict: second task fails, conflict message logged, worktree cleaned up for retry', async () => {
    // Add a shared file so both branches can conflict on it
    execSync(
      'printf "shared content\\n" > shared.txt && git add . && git commit -m "add shared"',
      { cwd: repoPath }
    )

    createTask(db, { id: 'task-a', title: 'Task A' })
    createTask(db, { id: 'task-b', title: 'Task B' })

    // Spawn both workers — both worktrees branch from the same HEAD
    const spawnA = await handleSpawnWorker(db, 'task-a', 'w-a', { cwd: repoPath })
    expect(spawnA.ok).toBe(true)
    const spawnB = await handleSpawnWorker(db, 'task-b', 'w-b', { cwd: repoPath })
    expect(spawnB.ok).toBe(true)

    const taskA = db.prepare("SELECT * FROM tasks WHERE id = 'task-a'").get() as TaskRow
    const taskB = db.prepare("SELECT * FROM tasks WHERE id = 'task-b'").get() as TaskRow
    expect(taskA.worktree_path).toBeTruthy()
    expect(taskB.worktree_path).toBeTruthy()

    // Track both for cleanup safety (both should be removed by handleReportDone, but guard just in case)
    worktreesToClean.push(taskA.worktree_path!, taskB.worktree_path!)

    // Both workers edit the same lines of shared.txt differently
    writeFileSync(join(taskA.worktree_path!, 'shared.txt'), 'task-a version\n')
    execSync('git add . && git commit -m "task-a edits shared"', { cwd: taskA.worktree_path! })

    writeFileSync(join(taskB.worktree_path!, 'shared.txt'), 'task-b version\n')
    execSync('git add . && git commit -m "task-b edits shared"', { cwd: taskB.worktree_path! })

    // Task A finishes first — clean merge into mc/integration
    await handleReportDone(db, 'task-a', 'Task A complete')
    const statusA = db.prepare("SELECT status FROM tasks WHERE id = 'task-a'").get() as { status: string }
    expect(statusA.status).toBe('done')

    // Now mc/integration has task-a's "task-a version". Task B tries to merge its
    // conflicting "task-b version" — this causes a merge conflict.
    await handleReportDone(db, 'task-b', 'Task B complete')

    // Task B must be marked failed
    const statusB = db.prepare("SELECT status FROM tasks WHERE id = 'task-b'").get() as { status: string }
    expect(statusB.status).toBe('failed')

    // An error log with the conflict message must exist
    const conflictLog = db.prepare(
      "SELECT message FROM logs WHERE task_id = 'task-b' AND level = 'error' LIMIT 1"
    ).get() as { message: string } | undefined
    expect(conflictLog?.message).toContain('Merge conflict')
    expect(conflictLog?.message).toContain('mc/task-b')

    // Worktree for task-b is removed on failure so retries can recreate it with the same branch name
    expect(existsSync(taskB.worktree_path!)).toBe(false)
  }, 15000)
})
