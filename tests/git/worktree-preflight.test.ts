import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktree, removeWorktree, preflightReconcile, isProtectedBranch } from '../../src/git/worktree.js'
import { simpleGit } from 'simple-git'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('isProtectedBranch', () => {
  it('returns true for main', () => {
    expect(isProtectedBranch('main')).toBe(true)
  })

  it('returns true for master', () => {
    expect(isProtectedBranch('master')).toBe(true)
  })

  it('returns true for mc/run-* branches', () => {
    expect(isProtectedBranch('mc/run-abc123')).toBe(true)
    expect(isProtectedBranch('mc/run-479497dd-24ad-46f3')).toBe(true)
  })

  it('returns false for task and feature branches', () => {
    expect(isProtectedBranch('feature/add-auth')).toBe(false)
    expect(isProtectedBranch('mc/task-1')).toBe(false)
    expect(isProtectedBranch('fix/broken-config')).toBe(false)
  })
})

describe('worktree preflight reconcile', () => {
  let repoPath: string
  const worktrees: string[] = []

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-preflight-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
    worktrees.length = 0
  })

  afterEach(() => {
    for (const wt of worktrees) {
      try { execSync(`git worktree remove --force "${wt}"`, { cwd: repoPath }) } catch {}
      rmSync(wt, { recursive: true, force: true })
    }
    try { execSync('git worktree prune', { cwd: repoPath }) } catch {}
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('prunes a worktree whose directory no longer exists', async () => {
    const info1 = await createWorktree(repoPath, 'task-stale')
    const stalePath = info1.path

    // Delete the directory to simulate a crash — worktree entry remains
    rmSync(stalePath, { recursive: true, force: true })
    const before = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(before).toContain(stalePath)

    // Second createWorktree should prune the stale entry and succeed
    const info2 = await createWorktree(repoPath, 'task-stale')
    worktrees.push(info2.path)

    expect(info2.branch).toBe('mc/task-stale')
    // Pruning cleared the stale worktree, then the zero-commit branch was deleted
    expect(info2.reconcileActions.some(a => a.type === 'delete-branch')).toBe(true)

    // Stale entry should be gone
    const after = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(after).not.toContain(stalePath)
    expect(after).toContain(info2.path)
  })

  it('reuses a branch with zero unique commits', async () => {
    // Create an orphan branch at HEAD (no unique commits vs HEAD)
    execSync('git branch mc/task-zero', { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-zero')
    worktrees.push(info.path)

    expect(info.branch).toBe('mc/task-zero')
    expect(info.reconcileActions.some(a => a.type === 'delete-branch')).toBe(true)
    expect(info.priorBranch).toBeUndefined()
  })

  it('preserves a branch with unique commits by allocating a new name', async () => {
    // Create a branch with a unique commit
    execSync('git checkout -b mc/task-preserve', { cwd: repoPath })
    writeFileSync(join(repoPath, 'unique.txt'), 'unique work')
    execSync('git add . && git commit -m "unique work"', { cwd: repoPath })
    execSync('git checkout -', { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-preserve')
    worktrees.push(info.path)

    expect(info.branch).toBe('mc/task-preserve-attempt-2')
    expect(info.priorBranch).toBe('mc/task-preserve')
    expect(info.reconcileActions.some(a => a.type === 'allocate-suffix')).toBe(true)

    // Original branch must still exist with its commits
    const branches = execSync('git branch', { cwd: repoPath }).toString()
    expect(branches).toContain('mc/task-preserve')
    const log = execSync('git log --oneline mc/task-preserve', { cwd: repoPath }).toString()
    expect(log).toContain('unique work')
  })

  it('refuses to reconcile main branch', async () => {
    const git = simpleGit(repoPath)
    await expect(preflightReconcile(git, 'main')).rejects.toThrow(/protected branch/)
  })

  it('refuses to reconcile master branch', async () => {
    const git = simpleGit(repoPath)
    await expect(preflightReconcile(git, 'master')).rejects.toThrow(/protected branch/)
  })

  it('refuses to reconcile mc/run-* integration branch', async () => {
    const git = simpleGit(repoPath)
    await expect(preflightReconcile(git, 'mc/run-abc123')).rejects.toThrow(/protected branch/)
  })

  it('removes a registered worktree when its working tree is clean', async () => {
    const info1 = await createWorktree(repoPath, 'task-clean-wt')
    // Worktree exists and is clean (no changes made)

    const info2 = await createWorktree(repoPath, 'task-clean-wt')
    worktrees.push(info2.path)

    expect(info2.branch).toBe('mc/task-clean-wt')
    expect(info2.reconcileActions.some(a => a.type === 'remove-worktree')).toBe(true)

    // First worktree path should no longer be a worktree
    const wtList = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(wtList).not.toContain(info1.path)
    expect(wtList).toContain(info2.path)
  })

  it('returns empty reconcileActions when no cleanup is needed', async () => {
    const info = await createWorktree(repoPath, 'task-clean')
    worktrees.push(info.path)

    expect(info.reconcileActions).toEqual([])
    expect(info.priorBranch).toBeUndefined()
  })

  it('reconcile actions contain structured detail strings', async () => {
    // Create a branch with unique commits to trigger allocate-suffix
    execSync('git checkout -b mc/task-detail', { cwd: repoPath })
    writeFileSync(join(repoPath, 'detail.txt'), 'detail work')
    execSync('git add . && git commit -m "detail commit"', { cwd: repoPath })
    execSync('git checkout -', { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-detail')
    worktrees.push(info.path)

    const suffixAction = info.reconcileActions.find(a => a.type === 'allocate-suffix')
    expect(suffixAction).toBeDefined()
    expect(suffixAction!.target).toBe('mc/task-detail-attempt-2')
    expect(suffixAction!.detail).toContain('mc/task-detail')
    expect(suffixAction!.detail).toContain('unique commit')
  })

  it('allocates incrementing suffixes when prior attempts exist', async () => {
    // Create branches simulating two prior attempts
    execSync('git checkout -b mc/task-multi', { cwd: repoPath })
    writeFileSync(join(repoPath, 'v1.txt'), 'v1')
    execSync('git add . && git commit -m "v1"', { cwd: repoPath })
    execSync('git checkout -', { cwd: repoPath })

    execSync('git checkout -b mc/task-multi-attempt-2', { cwd: repoPath })
    writeFileSync(join(repoPath, 'v2.txt'), 'v2')
    execSync('git add . && git commit -m "v2"', { cwd: repoPath })
    execSync('git checkout -', { cwd: repoPath })

    const info = await createWorktree(repoPath, 'task-multi')
    worktrees.push(info.path)

    expect(info.branch).toBe('mc/task-multi-attempt-3')
    expect(info.priorBranch).toBe('mc/task-multi')
  })

  it('uses baseBranch for unique commit comparison when provided', async () => {
    // Create a base branch ahead of HEAD
    execSync('git checkout -b base-branch', { cwd: repoPath })
    writeFileSync(join(repoPath, 'base.txt'), 'base work')
    execSync('git add . && git commit -m "base commit"', { cwd: repoPath })

    // Create a task branch from base-branch (no unique commits vs base)
    execSync('git branch mc/task-based', { cwd: repoPath })
    execSync('git checkout -', { cwd: repoPath })

    // mc/task-based has commits vs HEAD but zero vs base-branch
    const info = await createWorktree(repoPath, 'task-based', undefined, 'base-branch')
    worktrees.push(info.path)

    expect(info.branch).toBe('mc/task-based')
    expect(info.reconcileActions.some(a => a.type === 'delete-branch')).toBe(true)
    expect(info.priorBranch).toBeUndefined()
  })
})
