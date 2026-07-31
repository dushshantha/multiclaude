import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../../src/server/state/tasks.js'
import { registerAgent } from '../../src/server/state/agents.js'
import { handleReportDone } from '../../src/server/tools/worker.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { ensureIntegrationBranch } from '../../src/git/merge.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-empty-branch-test-'))
  execSync('git init', { cwd: dir })
  execSync('git config user.email "test@test.com"', { cwd: dir })
  execSync('git config user.name "Test"', { cwd: dir })
  execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: dir })
  return dir
}

describe('empty branch detection', () => {
  let db: Database.Database
  let repoPath: string

  beforeEach(() => {
    db = createDb(':memory:')
    repoPath = makeRepo()
  })

  afterEach(() => {
    closeDb(db)
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('marks task failed when task branch has no commits', async () => {
    const info = await createWorktree(repoPath, 'task-empty', 'feat: empty task')

    createTask(db, { id: 'task-empty', title: 'Empty task' })
    updateTask(db, 'task-empty', {
      status: 'in_progress',
      worktree_path: info.path,
      branch: info.branch,
      head_sha: info.headSha,
      repo_path: repoPath,
      agent_id: 'w-empty',
    })
    registerAgent(db, { id: 'w-empty', task_id: 'task-empty' })

    // Do NOT commit anything — zero-commit branch

    await handleReportDone(db, 'task-empty', 'task complete')

    const task = getTask(db, 'task-empty')
    expect(task?.status).toBe('failed')
    expect(task?.failure_reason).toBe('task branch has no commits')

    // Verify the failure is logged
    const log = db.prepare("SELECT * FROM logs WHERE task_id = 'task-empty' AND level = 'error'").get() as { message: string } | undefined
    expect(log?.message).toContain('no commits')
  })

  it('marks task done and merges when task branch has commits', async () => {
    await ensureIntegrationBranch(repoPath, 'run-123')
    const info = await createWorktree(repoPath, 'task-with-commits', 'feat: real work')

    createTask(db, { id: 'task-with-commits', title: 'Real work', run_id: undefined })
    updateTask(db, 'task-with-commits', {
      status: 'in_progress',
      worktree_path: info.path,
      branch: info.branch,
      head_sha: info.headSha,
      repo_path: repoPath,
      agent_id: 'w-commits',
    })
    registerAgent(db, { id: 'w-commits', task_id: 'task-with-commits' })

    // Make a real commit in the worktree
    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add feature"', { cwd: info.path })

    await handleReportDone(db, 'task-with-commits', 'feature implemented')

    const task = getTask(db, 'task-with-commits')
    expect(task?.status).toBe('done')
    expect(task?.failure_reason).toBeNull()

    // Verify the success log is written
    const log = db.prepare("SELECT * FROM logs WHERE task_id = 'task-with-commits' AND level = 'info' AND message LIKE 'DONE:%'").get() as { message: string } | undefined
    expect(log?.message).toContain('feature implemented')
  })

  it('proceeds normally when head_sha is not stored (legacy task without head_sha)', async () => {
    await ensureIntegrationBranch(repoPath)
    const info = await createWorktree(repoPath, 'task-legacy', 'feat: legacy task')

    createTask(db, { id: 'task-legacy', title: 'Legacy task' })
    updateTask(db, 'task-legacy', {
      status: 'in_progress',
      worktree_path: info.path,
      branch: info.branch,
      // intentionally omit head_sha — simulates old task records without the column
      repo_path: repoPath,
      agent_id: 'w-legacy',
    })
    registerAgent(db, { id: 'w-legacy', task_id: 'task-legacy' })

    writeFileSync(join(info.path, 'legacy.ts'), 'export const legacy = true')
    execSync('git add . && git commit -m "legacy commit"', { cwd: info.path })

    await handleReportDone(db, 'task-legacy', 'legacy done')

    const task = getTask(db, 'task-legacy')
    expect(task?.status).toBe('done')
  })

  it('failure_reason is stored on the task record and visible via getTask', async () => {
    const info = await createWorktree(repoPath, 'task-reason', 'feat: reason check')

    createTask(db, { id: 'task-reason', title: 'Reason check' })
    updateTask(db, 'task-reason', {
      status: 'in_progress',
      worktree_path: info.path,
      branch: info.branch,
      head_sha: info.headSha,
      repo_path: repoPath,
      agent_id: 'w-reason',
    })
    registerAgent(db, { id: 'w-reason', task_id: 'task-reason' })

    await handleReportDone(db, 'task-reason', 'done')

    const task = getTask(db, 'task-reason')
    expect(task?.failure_reason).toBe('task branch has no commits')
    // Confirms the field is persisted and readable, not just set in-memory
  })
})
