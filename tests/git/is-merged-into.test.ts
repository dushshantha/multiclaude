/**
 * Tests for isMergedInto — the ancestor check used by handleReportDone
 * to distinguish "merge landed, cleanup failed" from genuine merge failures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isMergedInto, ensureIntegrationBranch, mergeWorktreeBranch } from '../../src/git/merge.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mc-is-merged-test-'))
  execSync('git init', { cwd: dir })
  execSync('git config user.email "test@test.com"', { cwd: dir })
  execSync('git config user.name "Test"', { cwd: dir })
  execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: dir })
  return dir
}

describe('isMergedInto', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = makeRepo()
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('returns true when task branch is merged into integration branch', async () => {
    const runId = 'merged-true'
    await ensureIntegrationBranch(repoPath, runId)
    const info = await createWorktree(repoPath, 'task-a', 'feat: task-a')
    writeFileSync(join(info.path, 'a.ts'), 'export const a = 1')
    execSync('git add . && git commit -m "add a"', { cwd: info.path })

    await mergeWorktreeBranch(repoPath, info.branch, runId)

    const result = await isMergedInto(repoPath, info.branch, `mc/run-${runId}`)
    expect(result).toBe(true)

    await removeWorktree(repoPath, info)
  })

  it('returns false when task branch is NOT merged', async () => {
    const runId = 'not-merged'
    await ensureIntegrationBranch(repoPath, runId)
    const info = await createWorktree(repoPath, 'task-b', 'feat: task-b')
    writeFileSync(join(info.path, 'b.ts'), 'export const b = 2')
    execSync('git add . && git commit -m "add b"', { cwd: info.path })

    // Deliberately do NOT merge — task branch is NOT an ancestor of the run branch
    const result = await isMergedInto(repoPath, info.branch, `mc/run-${runId}`)
    expect(result).toBe(false)

    await removeWorktree(repoPath, info)
  })

  it('returns false without throwing when local task branch does not exist', async () => {
    const runId = 'missing-branch'
    await ensureIntegrationBranch(repoPath, runId)

    await expect(
      isMergedInto(repoPath, 'feature/nonexistent-task', `mc/run-${runId}`)
    ).resolves.toBe(false)
  })

  it('returns true via origin/<branch> when local task branch has been deleted after merge', async () => {
    // Set up a bare repo as origin so we can push the task branch there
    const originPath = mkdtempSync(join(tmpdir(), 'mc-is-merged-origin-'))
    try {
      execSync('git init --bare', { cwd: originPath })
      execSync(`git remote add origin ${originPath}`, { cwd: repoPath })
      execSync('git push -u origin HEAD:main', { cwd: repoPath })

      const runId = 'deleted-local-branch'
      await ensureIntegrationBranch(repoPath, runId)
      const info = await createWorktree(repoPath, 'task-c', 'feat: task-c')
      writeFileSync(join(info.path, 'c.ts'), 'export const c = 3')
      execSync('git add . && git commit -m "add c"', { cwd: info.path })

      // Push task branch to origin BEFORE cleanup
      execSync(`git push origin ${info.branch}`, { cwd: repoPath })

      // Merge into integration branch
      await mergeWorktreeBranch(repoPath, info.branch, runId)

      // Run actual post-merge cleanup: removes worktree + deletes local branch
      await removeWorktree(repoPath, info)

      // isMergedInto must still return true via origin/<branch>
      const result = await isMergedInto(repoPath, info.branch, `mc/run-${runId}`)
      expect(result).toBe(true)
    } finally {
      rmSync(originPath, { recursive: true, force: true })
    }
  })

  it('returns false without throwing when branch is absent both locally and on origin', async () => {
    // Origin exists but the task branch was never pushed there
    const originPath = mkdtempSync(join(tmpdir(), 'mc-is-merged-origin2-'))
    try {
      execSync('git init --bare', { cwd: originPath })
      execSync(`git remote add origin ${originPath}`, { cwd: repoPath })
      execSync('git push -u origin HEAD:main', { cwd: repoPath })

      const runId = 'absent-everywhere'
      await ensureIntegrationBranch(repoPath, runId)

      await expect(
        isMergedInto(repoPath, 'feature/ghost-branch', `mc/run-${runId}`)
      ).resolves.toBe(false)
    } finally {
      rmSync(originPath, { recursive: true, force: true })
    }
  })
})
