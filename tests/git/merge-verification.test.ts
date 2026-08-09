import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, updateTask, getTask } from '../../src/server/state/tasks.js'
import { registerAgent } from '../../src/server/state/agents.js'
import { handleReportDone } from '../../src/server/tools/worker.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { ensureIntegrationBranch, mergeWorktreeBranch, MergeConflictError } from '../../src/git/merge.js'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { useTempDir } from '../helpers/temp.js'

describe('merge verification', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-merge-verify-test-')
  })

  it('ancestor check passes after successful merge', async () => {
    const runId = 'ancestor-pass'
    await ensureIntegrationBranch(repoPath, runId)
    const info = await createWorktree(repoPath, 'task-ok', 'feat: ok')
    tmp.trackWorktree(info, repoPath)

    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add feature"', { cwd: info.path })

    await mergeWorktreeBranch(repoPath, info.branch, runId)

    // Verify the task branch is an ancestor of the integration branch
    const result = execSync(
      `git merge-base --is-ancestor ${info.branch} mc/run-${runId} && echo yes || echo no`,
      { cwd: repoPath }
    ).toString().trim()
    expect(result).toBe('yes')

    await removeWorktree(repoPath, info)
  })

  it('ancestor check detects unmerged branches', async () => {
    const runId = 'ancestor-fail'
    await ensureIntegrationBranch(repoPath, runId)
    const info = await createWorktree(repoPath, 'task-unmerged', 'feat: unmerged')
    tmp.trackWorktree(info, repoPath)

    writeFileSync(join(info.path, 'unmerged.ts'), 'export const y = 2')
    execSync('git add . && git commit -m "unmerged commit"', { cwd: info.path })

    // Do NOT merge — the task branch should NOT be an ancestor of the integration branch
    const exitCode = execSync(
      `git merge-base --is-ancestor ${info.branch} mc/run-${runId} 2>/dev/null; echo $?`,
      { cwd: repoPath }
    ).toString().trim()
    expect(exitCode).toBe('1')

    await removeWorktree(repoPath, info)
  })

  it('conflicted merge throws MergeConflictError', async () => {
    const runId = 'conflict-test'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // Diverge the integration branch with a conflicting file
    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'conflict.ts'), 'export const value = "integration"')
    execSync('git add . && git commit -m "integ side"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    // Create worktree with a conflicting change
    const info = await createWorktree(repoPath, 'task-conflict', 'feat: conflict')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'conflict.ts'), 'export const value = "worker"')
    execSync('git add . && git commit -m "worker side"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId))
      .rejects.toThrow(MergeConflictError)

    await removeWorktree(repoPath, info)
  })

  it('conflicted merge leaves the integration branch unchanged', async () => {
    const runId = 'clean-state'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // Record integration branch HEAD before the failed merge
    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'conflict.ts'), 'export const v = "a"')
    execSync('git add . && git commit -m "integ change"', { cwd: repoPath })
    const headBefore = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-clean', 'feat: clean')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'conflict.ts'), 'export const v = "b"')
    execSync('git add . && git commit -m "worker change"', { cwd: info.path })

    await expect(mergeWorktreeBranch(repoPath, info.branch, runId))
      .rejects.toThrow(MergeConflictError)

    // Integration branch HEAD should be unchanged
    const headAfter = execSync(`git rev-parse ${integBranch}`, { cwd: repoPath }).toString().trim()
    expect(headAfter).toBe(headBefore)

    await removeWorktree(repoPath, info)
  })

  it('MergeConflictError exposes conflicted file names', async () => {
    const runId = 'conflict-files'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'a.ts'), 'integ')
    writeFileSync(join(repoPath, 'b.ts'), 'integ')
    execSync('git add . && git commit -m "integ files"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-files', 'feat: files')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'a.ts'), 'worker')
    writeFileSync(join(info.path, 'b.ts'), 'worker')
    execSync('git add . && git commit -m "worker files"', { cwd: info.path })

    try {
      await mergeWorktreeBranch(repoPath, info.branch, runId)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(MergeConflictError)
      const conflict = err as MergeConflictError
      expect(conflict.conflictedFiles).toContain('a.ts')
      expect(conflict.conflictedFiles).toContain('b.ts')
      expect(conflict.taskBranch).toBe(info.branch)
      expect(conflict.integBranch).toBe(integBranch)
    }

    await removeWorktree(repoPath, info)
  })
})

describe('merge verification in handleReportDone', () => {
  const tmp = useTempDir()
  let db: Database.Database
  let repoPath: string

  beforeEach(() => {
    db = createDb(':memory:')
    repoPath = tmp.repo('mc-merge-verify-test-')
  })

  // afterEach for db (tmp handles dirs/worktrees)
  afterEach(() => {
    closeDb(db)
  })

  it('marks task done when merge succeeds and ancestor check passes', async () => {
    await ensureIntegrationBranch(repoPath)
    const info = await createWorktree(repoPath, 'task-done', 'feat: done')
    tmp.trackWorktree(info, repoPath)

    createTask(db, { id: 'task-done', title: 'Done task' })
    updateTask(db, 'task-done', {
      status: 'in_progress',
      worktree_path: info.path,
      branch: info.branch,
      head_sha: info.headSha,
      repo_path: repoPath,
      agent_id: 'w-done',
    })
    registerAgent(db, { id: 'w-done', task_id: 'task-done' })

    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add feature"', { cwd: info.path })

    await handleReportDone(db, 'task-done', 'feature complete')

    const task = getTask(db, 'task-done')
    expect(task?.status).toBe('done')
    expect(task?.failure_reason).toBeNull()
  })

  it('marks task failed with "merge conflict" reason on conflict', async () => {
    await ensureIntegrationBranch(repoPath)
    const integBranch = 'mc/integration'

    // Diverge the integration branch
    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'conflict.ts'), 'export const v = "integ"')
    execSync('git add . && git commit -m "integ side"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-conflict', 'feat: conflict')
    // On merge conflict, handleReportDone keeps the worktree for inspection.
    // Register it so afterEach cleans it up after the test finishes.
    tmp.trackWorktree(info, repoPath)

    createTask(db, { id: 'task-conflict', title: 'Conflict task' })
    updateTask(db, 'task-conflict', {
      status: 'in_progress',
      worktree_path: info.path,
      branch: info.branch,
      head_sha: info.headSha,
      repo_path: repoPath,
      agent_id: 'w-conflict',
    })
    registerAgent(db, { id: 'w-conflict', task_id: 'task-conflict' })

    writeFileSync(join(info.path, 'conflict.ts'), 'export const v = "worker"')
    execSync('git add . && git commit -m "worker side"', { cwd: info.path })

    await handleReportDone(db, 'task-conflict', 'task done')

    const task = getTask(db, 'task-conflict')
    expect(task?.status).toBe('failed')
    expect(task?.failure_reason).toBe('merge_conflict')

    const log = db.prepare(
      "SELECT * FROM logs WHERE task_id = 'task-conflict' AND level = 'error'"
    ).get() as { message: string } | undefined
    expect(log?.message).toContain('Merge conflict')
    expect(log?.message).toContain('conflict')
  })

  it('failure_reason distinguishes "merge conflict" from "task branch has no commits"', async () => {
    // Set up an empty-branch scenario
    const info = await createWorktree(repoPath, 'task-empty', 'feat: empty')
    tmp.trackWorktree(info, repoPath)

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

    await handleReportDone(db, 'task-empty', 'done')

    const emptyTask = getTask(db, 'task-empty')
    expect(emptyTask?.failure_reason).toBe('task branch has no commits')

    // Now set up a conflict scenario using the fallback mc/integration branch
    await ensureIntegrationBranch(repoPath)
    const integBranch = 'mc/integration'
    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'x.ts'), 'integ')
    execSync('git add . && git commit -m "integ"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info2 = await createWorktree(repoPath, 'task-conflict', 'feat: conflict')
    // kept on conflict — register for afterEach cleanup
    tmp.trackWorktree(info2, repoPath)

    createTask(db, { id: 'task-conflict', title: 'Conflict task' })
    updateTask(db, 'task-conflict', {
      status: 'in_progress',
      worktree_path: info2.path,
      branch: info2.branch,
      head_sha: info2.headSha,
      repo_path: repoPath,
      agent_id: 'w-conflict',
    })
    registerAgent(db, { id: 'w-conflict', task_id: 'task-conflict' })

    writeFileSync(join(info2.path, 'x.ts'), 'worker')
    execSync('git add . && git commit -m "worker"', { cwd: info2.path })

    await handleReportDone(db, 'task-conflict', 'done')

    const conflictTask = getTask(db, 'task-conflict')
    expect(conflictTask?.failure_reason).toBe('merge_conflict')

    // The two reasons are distinct
    expect(emptyTask?.failure_reason).not.toBe(conflictTask?.failure_reason)
  })
})
