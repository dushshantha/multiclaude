import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorktree, removeWorktree, readWorktreeGitDir } from '../../src/git/worktree.js'
import { buildWorkerEnv } from '../../src/spawner/index.js'
import { ensureIntegrationBranch, mergeWorktreeBranch } from '../../src/git/merge.js'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('worktree commit isolation', () => {
  let parentRepo: string

  beforeEach(() => {
    parentRepo = mkdtempSync(join(tmpdir(), 'mc-isolation-test-'))
    execSync('git init', { cwd: parentRepo })
    execSync('git config user.email "test@test.com"', { cwd: parentRepo })
    execSync('git config user.name "Test"', { cwd: parentRepo })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: parentRepo })
  })

  afterEach(() => {
    rmSync(parentRepo, { recursive: true, force: true })
  })

  it('createWorktree returns gitDir pointing to parent .git/worktrees/', async () => {
    const info = await createWorktree(parentRepo, 'iso-1', 'feat: isolation test')
    expect(info.gitDir).toContain('.git/worktrees/')
    const isDir = execSync(`test -d "${info.gitDir}" && echo yes || echo no`).toString().trim()
    expect(isDir).toBe('yes')
    await removeWorktree(parentRepo, info)
  })

  it('createWorktree returns headSha matching base branch HEAD', async () => {
    const parentHead = execSync('git rev-parse HEAD', { cwd: parentRepo }).toString().trim()
    const info = await createWorktree(parentRepo, 'iso-2', 'feat: head check')
    expect(info.headSha).toBe(parentHead)
    await removeWorktree(parentRepo, info)
  })

  it('readWorktreeGitDir parses the .git file correctly', async () => {
    const info = await createWorktree(parentRepo, 'iso-3')
    const gitDir = readWorktreeGitDir(info.path)
    expect(gitDir).toBe(info.gitDir)
    const dotGitContent = readFileSync(join(info.path, '.git'), 'utf8')
    expect(dotGitContent).toContain('gitdir:')
    await removeWorktree(parentRepo, info)
  })

  it('with isolation env vars, git commit from worktree lands on task branch', async () => {
    const info = await createWorktree(parentRepo, 'iso-4', 'feat: commit test')
    const env = buildWorkerEnv('w-iso-4', { worktreePath: info.path, gitDir: info.gitDir })

    writeFileSync(join(info.path, 'feature.ts'), 'export const x = 1')
    execSync('git add feature.ts && git commit -m "add feature"', { cwd: info.path, env })

    const branchLog = execSync(`git log --oneline ${info.branch}`, { cwd: parentRepo }).toString()
    expect(branchLog).toContain('add feature')

    const parentBranch = execSync('git branch --show-current', { cwd: parentRepo }).toString().trim()
    const parentLog = execSync(`git log --oneline ${parentBranch}`, { cwd: parentRepo }).toString()
    expect(parentLog).not.toContain('add feature')

    await removeWorktree(parentRepo, info)
  })

  it('with isolation env vars, git operations from PARENT repo cwd still target worktree', async () => {
    const info = await createWorktree(parentRepo, 'iso-5', 'feat: cwd isolation')
    const env = buildWorkerEnv('w-iso-5', { worktreePath: info.path, gitDir: info.gitDir })

    writeFileSync(join(info.path, 'isolated.ts'), 'export const isolated = true')

    // Run git commands from the PARENT repo's directory with isolation env vars —
    // GIT_DIR + GIT_WORK_TREE force git to operate on the worktree, not the parent
    execSync('git add -A && git commit -m "isolated commit"', { cwd: parentRepo, env })

    const worktreeBranchLog = execSync(`git log --oneline ${info.branch}`, { cwd: parentRepo }).toString()
    expect(worktreeBranchLog).toContain('isolated commit')

    const parentBranch = execSync('git branch --show-current', { cwd: parentRepo }).toString().trim()
    const parentLog = execSync(`git log --oneline ${parentBranch}`, { cwd: parentRepo }).toString()
    expect(parentLog).not.toContain('isolated commit')

    await removeWorktree(parentRepo, info)
  })

  it('without isolation env vars, git commands from parent cwd affect parent branch (demonstrates the bug)', async () => {
    await createWorktree(parentRepo, 'iso-6', 'feat: no isolation')

    writeFileSync(join(parentRepo, 'parent-file.ts'), 'export const parent = true')
    execSync('git add parent-file.ts && git commit -m "parent commit"', { cwd: parentRepo })

    const parentBranch = execSync('git branch --show-current', { cwd: parentRepo }).toString().trim()
    const parentLog = execSync(`git log --oneline ${parentBranch}`, { cwd: parentRepo }).toString()
    expect(parentLog).toContain('parent commit')
  })

  it('merge into mc/run-<runId> still works after worktree commits with isolation', async () => {
    const runId = 'iso-run-1'
    await ensureIntegrationBranch(parentRepo, runId)

    const info = await createWorktree(parentRepo, 'iso-7', 'feat: merge test')
    const env = buildWorkerEnv('w-iso-7', { worktreePath: info.path, gitDir: info.gitDir })

    writeFileSync(join(info.path, 'merge-feature.ts'), 'export const merge = true')
    execSync('git add merge-feature.ts && git commit -m "merge test commit"', { cwd: info.path, env })

    await mergeWorktreeBranch(parentRepo, info.branch, runId)

    const files = execSync(`git show mc/run-${runId}:merge-feature.ts`, { cwd: parentRepo }).toString()
    expect(files).toContain('export const merge = true')

    await removeWorktree(parentRepo, info)
  })

  it('worktree branch naming still works correctly with gitDir/headSha fields', async () => {
    const info1 = await createWorktree(parentRepo, 'iso-branch-1', 'feat: branch naming')
    const info2 = await createWorktree(parentRepo, 'iso-branch-2', 'fix: another bug')

    expect(info1.branch).toBe('feature/branch-naming-1')
    expect(info2.branch).toBe('fix/another-bug-2')
    expect(info1.gitDir).toBeTruthy()
    expect(info2.gitDir).toBeTruthy()
    expect(info1.headSha).toBeTruthy()
    expect(info2.headSha).toBeTruthy()

    await removeWorktree(parentRepo, info1)
    await removeWorktree(parentRepo, info2)
  })

  it('headSha tracks the correct base when baseBranch is specified', async () => {
    execSync('git checkout -b dev', { cwd: parentRepo })
    writeFileSync(join(parentRepo, 'dev.ts'), 'export const dev = true')
    execSync('git add . && git commit -m "dev commit"', { cwd: parentRepo })
    const devHead = execSync('git rev-parse HEAD', { cwd: parentRepo }).toString().trim()
    execSync('git checkout -', { cwd: parentRepo })

    const info = await createWorktree(parentRepo, 'iso-base', 'feat: based on dev', 'dev')
    expect(info.headSha).toBe(devHead)

    await removeWorktree(parentRepo, info)
  })
})
