import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ensureIntegrationBranch, mergeWorktreeBranch } from '../../src/git/merge.js'
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

  it('creates integration branch if it does not exist', async () => {
    await ensureIntegrationBranch(repoPath)
    const branches = execSync('git branch', { cwd: repoPath }).toString()
    expect(branches).toContain('mc/integration')
  })

  it('merges a worktree branch into mc/integration', async () => {
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
})
