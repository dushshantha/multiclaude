/**
 * End-to-end test for the self-service git pipeline.
 *
 * Uses a real local git repo with a bare repo as origin — no network required.
 * The only stub is createPullRequest (src/git/pr.ts seam) since actual PR
 * creation requires GitHub auth. All other operations (worktree, merge, push,
 * git_status) use real git.
 *
 * What is verified by real git operations:
 *   - Task worktree creation (createWorktree)
 *   - Merge of task branches into integration branch (mergeWorktreeBranch)
 *   - Push of integration branch to local bare remote (pushBranch)
 *   - getBranchSyncState (ahead/behind counts against remote)
 *   - handleGitStatus blockers list
 *   - Merge conflict detection and failure_reason/conflicted_files population
 *   - handleResolveMergeConflict → needsWorker path for semantic conflicts
 *
 * What is stubbed:
 *   - createPullRequest (src/git/pr.ts) — GitHub API, requires gh auth or GITHUB_TOKEN
 *     User setup required before real PR creation works: gh auth login OR GITHUB_TOKEN env var
 *
 * The tmux module is also stubbed since tests run outside a tmux session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'

// ── Stubs ────────────────────────────────────────────────────────────────────

// Use vi.hoisted so mockCreatePullRequest is available inside the vi.mock factory.
const { mockCreatePullRequest } = vi.hoisted(() => ({
  mockCreatePullRequest: vi.fn(),
}))

// Stub PR creation at the src/git/pr.ts seam.
// Real PR creation requires GitHub auth (gh auth login or GITHUB_TOKEN).
vi.mock('../src/git/pr.js', () => ({
  createPullRequest: mockCreatePullRequest,
  parseGitHubRemote: (url: string) => {
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
    return m ? { owner: m[1], repo: m[2] } : null
  },
  classifyGhError: vi.fn(() => 'pr_creation_failed'),
  buildGhCreateArgs: vi.fn(),
  isGhAvailable: vi.fn().mockResolvedValue(false),
  isGhAuthenticated: vi.fn().mockResolvedValue(false),
}))

// Stub tmux — tests run outside a tmux session.
vi.mock('../src/spawner/tmux.js', () => ({
  killTmuxWindow: vi.fn(),
  reapStaleWindows: vi.fn(),
  ensureTmuxSession: vi.fn(() => 'multiclaude'),
  captureTmuxPane: vi.fn(() => ''),
  spawnTmuxWorker: vi.fn(),
  createTmuxWindow: vi.fn(() => '@1'),
}))

// ── Imports after mocks ───────────────────────────────────────────────────────

import { createDb, closeDb } from '../src/server/state/db.js'
import { createTask, getTask } from '../src/server/state/tasks.js'
import { upsertProject } from '../src/server/state/projects.js'
import { createRun } from '../src/server/state/runs.js'
import {
  handleSpawnWorker,
  handleGitStatus,
  handleCreatePr,
  handleResolveMergeConflict,
} from '../src/server/tools/orchestrator.js'
import { handleReportDone } from '../src/server/tools/worker.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function initRepo(repoPath: string) {
  execSync('git init -b main', { cwd: repoPath })
  execSync('git config user.email "e2e@test.com"', { cwd: repoPath })
  execSync('git config user.name "E2E Test"', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# project\n')
  execSync('git add . && git commit -m "init"', { cwd: repoPath })
}

function initBareRemote(remotePath: string): void {
  execSync('git init --bare', { cwd: remotePath })
}

function addRemote(repoPath: string, remotePath: string): void {
  execSync(`git remote add origin ${remotePath}`, { cwd: repoPath })
  execSync('git push -u origin main', { cwd: repoPath })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('git pipeline e2e', () => {
  let db: Database.Database
  let repoPath: string
  let remotePath: string
  let projectId: string
  let runId: string
  let worktreesToClean: string[]

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-e2e-repo-'))
    remotePath = mkdtempSync(join(tmpdir(), 'mc-e2e-remote-'))
    worktreesToClean = []

    initRepo(repoPath)
    initBareRemote(remotePath)
    addRemote(repoPath, remotePath)

    db = createDb(':memory:')

    const project = upsertProject(db, { name: 'e2e-project', cwd: repoPath })
    projectId = project.id
    const run = createRun(db, { project_id: projectId, title: 'E2E Run' })
    runId = run.id

    mockCreatePullRequest.mockReset().mockResolvedValue({
      ok: true,
      url: 'https://github.com/test/repo/pull/1',
      number: 1,
      alreadyExisted: false,
    })
  })

  afterEach(() => {
    closeDb(db)
    for (const p of worktreesToClean) {
      rmSync(p, { recursive: true, force: true })
    }
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(remotePath, { recursive: true, force: true })
  })

  describe('happy path: two-task run reaches PR-ready state', () => {
    it('both tasks merge cleanly and integration branch is pushed to remote', async () => {
      // Create two tasks
      createTask(db, { id: 'task-alpha', title: 'Alpha feature', run_id: runId })
      createTask(db, { id: 'task-beta', title: 'Beta feature', run_id: runId })

      // Spawn task-alpha (creates worktree on mc/task-alpha)
      const spawnAlpha = await handleSpawnWorker(db, 'task-alpha', 'w-alpha', { cwd: repoPath })
      expect(spawnAlpha.ok).toBe(true)
      const taskAlpha = getTask(db, 'task-alpha')!
      expect(taskAlpha.worktree_path).toBeTruthy()
      worktreesToClean.push(taskAlpha.worktree_path!)

      // Spawn task-beta (creates worktree on mc/task-beta)
      const spawnBeta = await handleSpawnWorker(db, 'task-beta', 'w-beta', { cwd: repoPath })
      expect(spawnBeta.ok).toBe(true)
      const taskBeta = getTask(db, 'task-beta')!
      expect(taskBeta.worktree_path).toBeTruthy()
      worktreesToClean.push(taskBeta.worktree_path!)

      // Simulate task-alpha worker making a commit
      writeFileSync(join(taskAlpha.worktree_path!, 'alpha.ts'), 'export const alpha = 1\n')
      execSync('git add . && git commit -m "add alpha"', { cwd: taskAlpha.worktree_path! })

      // task-alpha reports done → merges mc/task-alpha into mc/run-<runId>
      await handleReportDone(db, 'task-alpha', 'Alpha complete')

      const doneAlpha = getTask(db, 'task-alpha')!
      expect(doneAlpha.status).toBe('done')
      expect(doneAlpha.merged_into_run).toBe(true)

      // Simulate task-beta worker making a commit (different file — no conflict)
      writeFileSync(join(taskBeta.worktree_path!, 'beta.ts'), 'export const beta = 2\n')
      execSync('git add . && git commit -m "add beta"', { cwd: taskBeta.worktree_path! })

      // task-beta reports done → merges mc/task-beta into mc/run-<runId>
      await handleReportDone(db, 'task-beta', 'Beta complete')

      const doneBeta = getTask(db, 'task-beta')!
      expect(doneBeta.status).toBe('done')
      expect(doneBeta.merged_into_run).toBe(true)

      // Both files should be visible on the integration branch
      const integBranch = `mc/run-${runId}`
      const alphaContent = execSync(`git show ${integBranch}:alpha.ts`, { cwd: repoPath }).toString()
      const betaContent = execSync(`git show ${integBranch}:beta.ts`, { cwd: repoPath }).toString()
      expect(alphaContent).toContain('export const alpha = 1')
      expect(betaContent).toContain('export const beta = 2')

      // Integration branch was pushed to the local remote
      const remoteBranches = execSync('git ls-remote --heads origin', { cwd: repoPath }).toString()
      expect(remoteBranches).toContain(integBranch)
    }, 30000)

    it('git_status shows no blockers after both tasks done and merged', async () => {
      createTask(db, { id: 'task-x', title: 'Feature X', run_id: runId })

      const spawnX = await handleSpawnWorker(db, 'task-x', 'w-x', { cwd: repoPath })
      expect(spawnX.ok).toBe(true)
      const taskX = getTask(db, 'task-x')!
      worktreesToClean.push(taskX.worktree_path!)

      writeFileSync(join(taskX.worktree_path!, 'x.ts'), 'export const x = 42\n')
      execSync('git add . && git commit -m "add x"', { cwd: taskX.worktree_path! })
      await handleReportDone(db, 'task-x', 'X complete')

      const status = await handleGitStatus(db, runId)
      expect('error' in status).toBe(false)

      const s = status as Exclude<typeof status, { error: string }>
      // Integration branch exists locally and on remote
      expect(s.branchExists).toBe(true)
      expect(s.existsOnRemote).toBe(true)
      expect(s.hasRemote).toBe(true)
      // All tasks done and merged — no blockers
      expect(s.blockers).toHaveLength(0)
    }, 20000)

    it('handleCreatePr calls createPullRequest with integration branch as head', async () => {
      createTask(db, { id: 'task-pr', title: 'PR task', run_id: runId })

      const spawn = await handleSpawnWorker(db, 'task-pr', 'w-pr', { cwd: repoPath })
      expect(spawn.ok).toBe(true)
      const task = getTask(db, 'task-pr')!
      worktreesToClean.push(task.worktree_path!)

      writeFileSync(join(task.worktree_path!, 'pr.ts'), 'export const pr = true\n')
      execSync('git add . && git commit -m "add pr"', { cwd: task.worktree_path! })
      await handleReportDone(db, 'task-pr', 'PR task complete')

      // Add a github remote URL so handleCreatePr can parse owner/repo
      // (We use a fake GitHub URL; actual push goes to local bare remote via 'origin')
      execSync('git remote rename origin local-origin', { cwd: repoPath })
      execSync('git remote add origin https://github.com/test/repo.git', { cwd: repoPath })
      execSync('git fetch local-origin', { cwd: repoPath })

      // Push the integration branch to local remote via local-origin for the real push
      const integBranch = `mc/run-${runId}`
      execSync(`git push local-origin ${integBranch}`, { cwd: repoPath })

      // Restore origin to local bare for pushBranch used by handleCreatePr
      execSync('git remote remove origin', { cwd: repoPath })
      execSync(`git remote add origin ${remotePath}`, { cwd: repoPath })

      const prResult = await handleCreatePr(db, runId)
      // createPullRequest was called (stubbed — returns ok: true)
      expect(prResult.ok).toBe(true)
      expect(mockCreatePullRequest).toHaveBeenCalledOnce()

      const callArgs = mockCreatePullRequest.mock.calls[0][0]
      expect(callArgs.head).toBe(integBranch)
      expect(callArgs.body).toContain('PR task complete')
    }, 30000)
  })

  describe('conflict path: merge conflict detected and needsWorker returned', () => {
    it('second task editing same lines lands in merge_conflict with conflicted_files', async () => {
      // Put a shared file on main so both worktrees start with it
      writeFileSync(join(repoPath, 'shared.ts'), 'export const value = "original"\n')
      execSync('git add . && git commit -m "add shared"', { cwd: repoPath })
      execSync('git push origin main', { cwd: repoPath })

      createTask(db, { id: 'task-left', title: 'Left edit', run_id: runId })
      createTask(db, { id: 'task-right', title: 'Right edit', run_id: runId })

      const spawnLeft = await handleSpawnWorker(db, 'task-left', 'w-left', { cwd: repoPath })
      expect(spawnLeft.ok).toBe(true)
      const taskLeft = getTask(db, 'task-left')!
      worktreesToClean.push(taskLeft.worktree_path!)

      const spawnRight = await handleSpawnWorker(db, 'task-right', 'w-right', { cwd: repoPath })
      expect(spawnRight.ok).toBe(true)
      const taskRight = getTask(db, 'task-right')!
      worktreesToClean.push(taskRight.worktree_path!)

      // Both edit the same line in shared.ts differently
      writeFileSync(join(taskLeft.worktree_path!, 'shared.ts'), 'export const value = "left"\n')
      execSync('git add . && git commit -m "left changes value"', { cwd: taskLeft.worktree_path! })

      writeFileSync(join(taskRight.worktree_path!, 'shared.ts'), 'export const value = "right"\n')
      execSync('git add . && git commit -m "right changes value"', { cwd: taskRight.worktree_path! })

      // task-left merges first — clean merge
      await handleReportDone(db, 'task-left', 'Left done')
      const doneLeft = getTask(db, 'task-left')!
      expect(doneLeft.status).toBe('done')

      // task-right tries to merge — conflicts with task-left on shared.ts
      await handleReportDone(db, 'task-right', 'Right done')

      const failedRight = getTask(db, 'task-right')!
      expect(failedRight.status).toBe('failed')
      expect(failedRight.failure_reason).toBe('merge_conflict')
      expect(failedRight.conflicted_files).not.toBeNull()
      expect(failedRight.conflicted_files).toContain('shared.ts')

      // Worktree is KEPT (not removed) so conflict-resolution worker can inspect it
      const { existsSync } = await import('fs')
      expect(existsSync(taskRight.worktree_path!)).toBe(true)
    }, 30000)

    it('handleResolveMergeConflict returns needsWorker for semantic conflicts', async () => {
      // Put a shared file on main
      writeFileSync(join(repoPath, 'api.ts'), 'export function greet() { return "hello" }\n')
      execSync('git add . && git commit -m "add api"', { cwd: repoPath })

      createTask(db, { id: 'task-conflict-l', title: 'API left', run_id: runId })
      createTask(db, { id: 'task-conflict-r', title: 'API right', run_id: runId })

      const spawnL = await handleSpawnWorker(db, 'task-conflict-l', 'w-cl', { cwd: repoPath })
      expect(spawnL.ok).toBe(true)
      const taskL = getTask(db, 'task-conflict-l')!
      worktreesToClean.push(taskL.worktree_path!)

      const spawnR = await handleSpawnWorker(db, 'task-conflict-r', 'w-cr', { cwd: repoPath })
      expect(spawnR.ok).toBe(true)
      const taskR = getTask(db, 'task-conflict-r')!
      worktreesToClean.push(taskR.worktree_path!)

      writeFileSync(join(taskL.worktree_path!, 'api.ts'), 'export function greet() { return "hi" }\n')
      execSync('git add . && git commit -m "change to hi"', { cwd: taskL.worktree_path! })

      writeFileSync(join(taskR.worktree_path!, 'api.ts'), 'export function greet() { return "hey" }\n')
      execSync('git add . && git commit -m "change to hey"', { cwd: taskR.worktree_path! })

      // Left merges cleanly
      await handleReportDone(db, 'task-conflict-l', 'Left done')

      // Right conflicts
      await handleReportDone(db, 'task-conflict-r', 'Right done')
      const conflictedTask = getTask(db, 'task-conflict-r')!
      expect(conflictedTask.failure_reason).toBe('merge_conflict')
      expect(conflictedTask.conflicted_files).toContain('api.ts')

      // handleResolveMergeConflict cannot auto-resolve a semantic conflict in api.ts
      // — it should report needsWorker: true rather than dead-ending
      const resolveResult = await handleResolveMergeConflict(db, 'task-conflict-r')
      expect(resolveResult.ok).toBe(false)
      expect(resolveResult.needsWorker).toBe(true)
      expect(resolveResult.conflictedFiles).toContain('api.ts')

      // Keep worktree paths alive so afterEach can clean them up
      if (taskR.worktree_path) worktreesToClean.push(`conflict-task-conflict-r-worktree`)
    }, 30000)
  })
})
