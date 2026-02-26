import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktree, removeWorktree } from '../../src/git/worktree.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

  it('creates a worktree with a new branch', async () => {
    const info = await createWorktree(repoPath, 'task-1')
    expect(info.branch).toBe('mc/task-1')
    expect(info.path).toBeTruthy()
    // Verify worktree exists in git
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).toContain('mc/task-1')
    // Cleanup
    await removeWorktree(repoPath, info)
  })

  it('removes a worktree cleanly', async () => {
    const info = await createWorktree(repoPath, 'task-2')
    await removeWorktree(repoPath, info)
    const worktrees = execSync('git worktree list', { cwd: repoPath }).toString()
    expect(worktrees).not.toContain('mc/task-2')
  })
})
