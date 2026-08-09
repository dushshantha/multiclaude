import { describe, it, expect, beforeEach } from 'vitest'
import { ensureIntegrationBranch, mergeWorktreeBranch, RUN_INTEGRATION_BRANCH, MergeConflictError } from '../../src/git/merge.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { execSync } from 'child_process'
import { writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { useTempDir } from '../helpers/temp.js'

describe('merge', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-merge-test-')
  })

  it('creates integration branch if it does not exist (no runId = fallback mc/integration)', async () => {
    await ensureIntegrationBranch(repoPath)
    const branches = execSync('git branch', { cwd: repoPath }).toString()
    expect(branches).toContain('mc/integration')
  })

  it('creates per-run integration branch mc/run-{runId}', async () => {
    await ensureIntegrationBranch(repoPath, 'run-abc')
    const branches = execSync('git branch', { cwd: repoPath }).toString()
    expect(branches).toContain('mc/run-run-abc')
  })

  it('RUN_INTEGRATION_BRANCH helper returns correct branch name', () => {
    expect(RUN_INTEGRATION_BRANCH('abc123')).toBe('mc/run-abc123')
  })

  it('merges a worktree branch into mc/integration (no runId)', async () => {
    await ensureIntegrationBranch(repoPath)
    const info = await createWorktree(repoPath, 'task-1')
    tmp.trackWorktree(info, repoPath)
    // Make a commit in the worktree
    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add feature"', { cwd: info.path })
    await mergeWorktreeBranch(repoPath, info.branch)
    // Verify file is in integration branch
    const files = execSync('git show mc/integration:feature.ts', { cwd: repoPath }).toString()
    expect(files).toContain('export const x = 1')
    await removeWorktree(repoPath, info)
  })

  it('merges a worktree branch into mc/run-{runId} not mc/integration', async () => {
    const runId = 'test-run-123'
    await ensureIntegrationBranch(repoPath, runId)
    const info = await createWorktree(repoPath, 'task-2')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'feature2.ts'), 'export const y = 2')
    execSync('git add . && git commit -m "add feature2"', { cwd: info.path })
    await mergeWorktreeBranch(repoPath, info.branch, runId)
    // File should be in the run branch
    const files = execSync(`git show mc/run-${runId}:feature2.ts`, { cwd: repoPath }).toString()
    expect(files).toContain('export const y = 2')
    // mc/integration should NOT exist (we never created it)
    const allBranches = execSync('git branch', { cwd: repoPath }).toString()
    expect(allBranches).not.toContain('mc/integration')
    await removeWorktree(repoPath, info)
  })

  it('ensureIntegrationBranch works with uncommitted changes in main repo', async () => {
    // Write an uncommitted file — the old implementation would have failed here
    writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted change')
    await ensureIntegrationBranch(repoPath)
    const branches = execSync('git branch', { cwd: repoPath }).toString()
    expect(branches).toContain('mc/integration')
  })

  it('mergeWorktreeBranch works with uncommitted changes in main repo', async () => {
    await ensureIntegrationBranch(repoPath)
    const info = await createWorktree(repoPath, 'task-dirty')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'feature-dirty.ts'), 'export const z = 3')
    execSync('git add . && git commit -m "add feature-dirty"', { cwd: info.path })

    // Dirty the main repo working tree
    writeFileSync(join(repoPath, 'dirty.txt'), 'uncommitted change')

    // Should NOT throw — main repo working tree is never checked out
    await expect(mergeWorktreeBranch(repoPath, info.branch)).resolves.not.toThrow()

    const files = execSync('git show mc/integration:feature-dirty.ts', { cwd: repoPath }).toString()
    expect(files).toContain('export const z = 3')

    await removeWorktree(repoPath, info)
  })

  it('pushes integration branch to origin after merge', async () => {
    // Set up a bare repo as the remote origin
    const originPath = tmp.dir('mc-merge-origin-')
    execSync('git init --bare', { cwd: originPath })
    execSync(`git remote add origin ${originPath}`, { cwd: repoPath })
    // Push main branch so origin has a base
    execSync('git push -u origin HEAD:main', { cwd: repoPath })

    const runId = 'push-test-run'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`
    const info = await createWorktree(repoPath, 'task-push')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'pushed.ts'), 'export const pushed = true')
    execSync('git add . && git commit -m "add pushed file"', { cwd: info.path })

    await mergeWorktreeBranch(repoPath, info.branch, runId)

    // Verify the integration branch was pushed to origin
    const remoteBranches = execSync('git ls-remote --heads origin', { cwd: repoPath }).toString()
    expect(remoteBranches).toContain(integBranch)

    await removeWorktree(repoPath, info)
  })

  it('auto-resolves add/add conflict on package-lock.json', async () => {
    const runId = 'conflict-run'
    await ensureIntegrationBranch(repoPath, runId)

    // Add package-lock.json on the integration branch (diverging from worktree base)
    const originalBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${runId ? `mc/run-${runId}` : 'mc/integration'}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'package-lock.json'), '{"version": "integration"}')
    execSync('git add . && git commit -m "add lock on integration"', { cwd: repoPath })
    execSync(`git checkout ${originalBranch}`, { cwd: repoPath })

    // Create worktree from original branch (no package-lock.json) and also add one
    const info = await createWorktree(repoPath, 'task-lock')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'package-lock.json'), '{"version": "worker"}')
    execSync('git add . && git commit -m "add lock file on worker"', { cwd: info.path })

    // Should NOT throw — auto-resolves package-lock.json add/add conflict
    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    await removeWorktree(repoPath, info)
  })

  it('serializes concurrent merges into the same integration branch', async () => {
    const runId = 'concurrent-run'
    await ensureIntegrationBranch(repoPath, runId)

    // Create two worktrees with non-conflicting changes
    const info1 = await createWorktree(repoPath, 'task-concurrent-1')
    tmp.trackWorktree(info1, repoPath)
    writeFileSync(join(info1.path, 'feature-a.ts'), 'export const a = 1')
    execSync('git add . && git commit -m "add feature-a"', { cwd: info1.path })

    const info2 = await createWorktree(repoPath, 'task-concurrent-2')
    tmp.trackWorktree(info2, repoPath)
    writeFileSync(join(info2.path, 'feature-b.ts'), 'export const b = 2')
    execSync('git add . && git commit -m "add feature-b"', { cwd: info2.path })

    // Fire both merges concurrently — the mutex should serialize them without error
    await Promise.all([
      mergeWorktreeBranch(repoPath, info1.branch, runId),
      mergeWorktreeBranch(repoPath, info2.branch, runId),
    ])

    // Both files should be present on the integration branch
    const filesA = execSync(`git show mc/run-${runId}:feature-a.ts`, { cwd: repoPath }).toString()
    const filesB = execSync(`git show mc/run-${runId}:feature-b.ts`, { cwd: repoPath }).toString()
    expect(filesA).toContain('export const a = 1')
    expect(filesB).toContain('export const b = 2')

    await removeWorktree(repoPath, info1)
    await removeWorktree(repoPath, info2)
  })
})

// ---------------------------------------------------------------------------
// Regression: mergeWorktreeBranch must not leak its internal mc-merge-* tmpDir
// ---------------------------------------------------------------------------

describe('mergeWorktreeBranch temp dir cleanup', () => {
  const tmp = useTempDir()
  let repoPath: string

  beforeEach(() => {
    repoPath = tmp.repo('mc-merge-cleanup-test-')
  })

  it('cleans up mc-merge-* tmpDir after a successful merge', async () => {
    await ensureIntegrationBranch(repoPath, 'cleanup-ok')
    const info = await createWorktree(repoPath, 'task-cleanup-ok')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'ok.ts'), 'export const ok = true')
    execSync('git add . && git commit -m "add ok"', { cwd: info.path })

    // Snapshot of mc-merge-* dirs before the merge
    const before = execSync(`ls -d ${tmpdir()}mc-merge-*/ 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean)

    await mergeWorktreeBranch(repoPath, info.branch, 'cleanup-ok')

    // All mc-merge-* dirs created during the merge must be gone
    const after = execSync(`ls -d ${tmpdir()}mc-merge-*/ 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean)
    const leaked = after.filter(d => !before.includes(d))
    expect(leaked).toHaveLength(0)

    await removeWorktree(repoPath, info)
  })

  it('cleans up mc-merge-* tmpDir when merge throws MergeConflictError', async () => {
    await ensureIntegrationBranch(repoPath, 'cleanup-conflict')
    const integBranch = 'mc/run-cleanup-conflict'

    // Diverge the integration branch
    const origBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'conflict.ts'), 'export const v = "integ"')
    execSync('git add . && git commit -m "integ"', { cwd: repoPath })
    execSync(`git checkout ${origBranch}`, { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-cleanup-conflict')
    tmp.trackWorktree(info, repoPath)
    writeFileSync(join(info.path, 'conflict.ts'), 'export const v = "worker"')
    execSync('git add . && git commit -m "worker"', { cwd: info.path })

    const before = execSync(`ls -d ${tmpdir()}mc-merge-*/ 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean)

    await expect(mergeWorktreeBranch(repoPath, info.branch, 'cleanup-conflict'))
      .rejects.toThrow(MergeConflictError)

    const after = execSync(`ls -d ${tmpdir()}mc-merge-*/ 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean)
    const leaked = after.filter(d => !before.includes(d))
    expect(leaked).toHaveLength(0)

    await removeWorktree(repoPath, info)
  })
})
