import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ensureIntegrationBranch, mergeWorktreeBranch, RUN_INTEGRATION_BRANCH } from '../../src/git/merge.js'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
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

  it('auto-resolves add/add conflict on package-lock.json', async () => {
    const runId = 'conflict-run'
    await ensureIntegrationBranch(repoPath, runId)
    const integBranch = `mc/run-${runId}`

    // Add package-lock.json on the integration branch (diverging from worktree base)
    const originalBranch = execSync('git branch --show-current', { cwd: repoPath }).toString().trim()
    execSync(`git checkout ${integBranch}`, { cwd: repoPath })
    writeFileSync(join(repoPath, 'package-lock.json'), '{"version": "integration"}')
    execSync('git add . && git commit -m "add lock on integration"', { cwd: repoPath })
    execSync(`git checkout ${originalBranch}`, { cwd: repoPath })

    // Create worktree from original branch (no package-lock.json) and also add one
    const info = await createWorktree(repoPath, 'task-lock')
    writeFileSync(join(info.path, 'package-lock.json'), '{"version": "worker"}')
    execSync('git add . && git commit -m "add lock file on worker"', { cwd: info.path })

    // Should NOT throw — auto-resolves package-lock.json add/add conflict
    await expect(mergeWorktreeBranch(repoPath, info.branch, runId)).resolves.not.toThrow()

    await removeWorktree(repoPath, info)
  })
})
