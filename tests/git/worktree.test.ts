import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktree, removeWorktree, branchNameFromTitle } from '../../src/git/worktree.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('branchNameFromTitle', () => {
  it('uses feature/ prefix for non-fix titles', () => {
    expect(branchNameFromTitle('feat: add user auth')).toBe('feature/add-user-auth')
  })

  it('uses fix/ prefix when title starts with fix:', () => {
    expect(branchNameFromTitle('fix: broken login redirect')).toBe('fix/broken-login-redirect')
  })

  it('uses fix/ prefix when title contains bug keyword', () => {
    expect(branchNameFromTitle('bugfix: null pointer in user service')).toBe('fix/null-pointer-user')
  })

  it('uses fix/ prefix for patch prefix', () => {
    expect(branchNameFromTitle('patch: security vulnerability')).toBe('fix/security-vulnerability')
  })

  it('strips conventional commit prefix', () => {
    expect(branchNameFromTitle('chore: update dependencies')).toBe('feature/update-dependencies')
  })

  it('takes at most 3 words', () => {
    const branch = branchNameFromTitle('feat: one two three four five')
    expect(branch).toBe('feature/one-two-three')
  })

  it('filters stop words', () => {
    expect(branchNameFromTitle('feat: add the user to the system')).toBe('feature/add-user-system')
  })

  it('handles title with no conventional prefix', () => {
    expect(branchNameFromTitle('JWT auth implementation')).toBe('feature/jwt-auth-implementation')
  })

  it('appends taskId suffix when provided', () => {
    const branch = branchNameFromTitle('feat: add user auth', 'task-abc123')
    expect(branch).toBe('feature/add-user-auth-abc123')
  })

  it('appends short taskId for long task IDs', () => {
    const branch = branchNameFromTitle('feat: add user auth', 'task-abc123def456')
    expect(branch).toBe('feature/add-user-auth-abc123def456')
  })

  it('produces different branches for same title with different taskIds', () => {
    const branch1 = branchNameFromTitle('fix: auth bug', 'task-1')
    const branch2 = branchNameFromTitle('fix: auth bug', 'task-2')
    expect(branch1).not.toBe(branch2)
    expect(branch1).toBe('fix/auth-bug-1')
    expect(branch2).toBe('fix/auth-bug-2')
  })
})

describe('worktree', () => {
  let repoPath: string

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'mc-test-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('creates a worktree with feature/ branch when taskTitle is provided', async () => {
    const info = await createWorktree(repoPath, 'task-1', 'feat: add user auth')
    expect(info.branch).toBe('feature/add-user-auth-1')
    expect(info.path).toBeTruthy()
    // Verify worktree exists in git
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).toContain(info.branch)
    // Cleanup
    await removeWorktree(repoPath, info)
  })

  it('creates a worktree with fix/ branch for fix titles', async () => {
    const info = await createWorktree(repoPath, 'task-fix', 'fix: broken config')
    expect(info.branch).toBe('fix/broken-config-fix')
    await removeWorktree(repoPath, info)
  })

  it('falls back to mc/<taskId> when no taskTitle provided', async () => {
    const info = await createWorktree(repoPath, 'task-2')
    expect(info.branch).toBe('mc/task-2')
    await removeWorktree(repoPath, info)
  })

  it('removes a worktree cleanly', async () => {
    const info = await createWorktree(repoPath, 'task-3', 'feat: new feature')
    await removeWorktree(repoPath, info)
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).not.toContain(info.branch)
  })

  it('creates unique branches for tasks with identical titles but different IDs', async () => {
    const info1 = await createWorktree(repoPath, 'task-identical-1', 'fix: auth bug')
    const info2 = await createWorktree(repoPath, 'task-identical-2', 'fix: auth bug')

    expect(info1.branch).not.toBe(info2.branch)
    expect(info1.branch).toBe('fix/auth-bug-1')
    expect(info2.branch).toBe('fix/auth-bug-2')

    // Both worktrees should exist
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).toContain(info1.branch)
    expect(worktrees).toContain(info2.branch)

    await removeWorktree(repoPath, info1)
    await removeWorktree(repoPath, info2)
  })
})
