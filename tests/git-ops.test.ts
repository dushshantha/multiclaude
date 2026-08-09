import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseGitHubRemote,
  classifyPushFailure,
  hasRemote,
  getRemoteUrl,
  pushBranch,
  getBranchSyncState,
  isMainCheckout,
} from '../src/git/ops.js'

// Save and restore git env vars so tests that create temp repos are not
// affected by the GIT_DIR / GIT_WORK_TREE isolation set by the worktree runner.
function saveGitEnv(): Record<string, string | undefined> {
  return {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES,
  }
}

function clearGitEnv(): void {
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  delete process.env.GIT_CEILING_DIRECTORIES
}

function restoreGitEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v
    else delete process.env[k]
  }
}

// ── parseGitHubRemote ─────────────────────────────────────────────────────────

describe('parseGitHubRemote', () => {
  it('parses SSH URL with .git suffix', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses SSH URL without .git suffix', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses HTTPS URL with .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('parses HTTPS URL without .git suffix', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('returns null for GitLab SSH', () => {
    expect(parseGitHubRemote('git@gitlab.com:owner/repo.git')).toBeNull()
  })

  it('returns null for GitLab HTTPS', () => {
    expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeNull()
  })

  it('returns null for Bitbucket', () => {
    expect(parseGitHubRemote('https://bitbucket.org/owner/repo.git')).toBeNull()
  })

  it('returns null for a plain local path', () => {
    expect(parseGitHubRemote('/tmp/some-bare-repo')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseGitHubRemote('')).toBeNull()
  })

  it('handles org with dashes and underscores', () => {
    expect(parseGitHubRemote('git@github.com:my-org_123/my-repo.git')).toEqual({
      owner: 'my-org_123',
      repo: 'my-repo',
    })
  })

  it('strips trailing .git but not mid-name .git', () => {
    const result = parseGitHubRemote('https://github.com/owner/git-utils.git')
    expect(result).toEqual({ owner: 'owner', repo: 'git-utils' })
  })
})

// ── classifyPushFailure ───────────────────────────────────────────────────────

describe('classifyPushFailure', () => {
  it('classifies non-fast-forward rejection', () => {
    const stderr = "error: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind\nnon-fast-forward"
    expect(classifyPushFailure(stderr)).toBe('non_fast_forward')
  })

  it('classifies rejected (short form)', () => {
    expect(classifyPushFailure('! [rejected] main -> main (non-fast-forward)')).toBe('non_fast_forward')
  })

  it('classifies SSH Permission denied', () => {
    expect(classifyPushFailure('Permission denied (publickey).\nfatal: Could not read from remote repository.')).toBe('auth_failed')
  })

  it('classifies HTTPS Authentication failed', () => {
    expect(classifyPushFailure("remote: Authentication failed for 'https://github.com/org/repo.git'")).toBe('auth_failed')
  })

  it('classifies terminal-prompt disabled (HTTPS without credentials)', () => {
    expect(classifyPushFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe('auth_failed')
  })

  it('classifies missing src refspec', () => {
    expect(classifyPushFailure('error: src refspec feature/foo does not match any')).toBe('branch_missing')
  })

  it('classifies does not match any (alternate phrasing)', () => {
    expect(classifyPushFailure('error: src refspec nonexistent does not match any refs')).toBe('branch_missing')
  })

  it('falls back to push_failed for unrecognised errors', () => {
    expect(classifyPushFailure('fatal: unable to access repository: Connection refused')).toBe('push_failed')
  })
})

// ── hasRemote / getRemoteUrl ──────────────────────────────────────────────────

describe('hasRemote', () => {
  let repoPath: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = saveGitEnv()
    clearGitEnv()
    repoPath = mkdtempSync(join(tmpdir(), 'mc-ops-hasremote-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    restoreGitEnv(savedEnv)
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('returns false when no remotes configured', async () => {
    expect(await hasRemote(repoPath)).toBe(false)
  })

  it('returns true when origin is configured', async () => {
    execSync('git remote add origin https://github.com/test/test.git', { cwd: repoPath })
    expect(await hasRemote(repoPath)).toBe(true)
  })

  it('returns false when only a non-origin remote exists', async () => {
    execSync('git remote add upstream https://github.com/test/test.git', { cwd: repoPath })
    expect(await hasRemote(repoPath)).toBe(false)
  })
})

describe('getRemoteUrl', () => {
  let repoPath: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = saveGitEnv()
    clearGitEnv()
    repoPath = mkdtempSync(join(tmpdir(), 'mc-ops-remoteurl-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    restoreGitEnv(savedEnv)
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('returns null when no origin configured', async () => {
    expect(await getRemoteUrl(repoPath)).toBeNull()
  })

  it('returns the configured URL', async () => {
    execSync('git remote add origin https://github.com/owner/repo.git', { cwd: repoPath })
    expect(await getRemoteUrl(repoPath)).toBe('https://github.com/owner/repo.git')
  })
})

// ── pushBranch ────────────────────────────────────────────────────────────────

describe('pushBranch', () => {
  let repoPath: string
  let originPath: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = saveGitEnv()
    clearGitEnv()
    repoPath = mkdtempSync(join(tmpdir(), 'mc-ops-push-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })

    originPath = mkdtempSync(join(tmpdir(), 'mc-ops-origin-'))
    execSync('git init --bare', { cwd: originPath })
    execSync(`git remote add origin ${originPath}`, { cwd: repoPath })
  })

  afterEach(() => {
    restoreGitEnv(savedEnv)
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(originPath, { recursive: true, force: true })
  })

  it('returns ok:false with no_remote when no origin configured', async () => {
    const noRemotePath = mkdtempSync(join(tmpdir(), 'mc-ops-noremote-'))
    try {
      execSync('git init', { cwd: noRemotePath })
      execSync('git config user.email "test@test.com"', { cwd: noRemotePath })
      execSync('git config user.name "Test"', { cwd: noRemotePath })
      execSync('echo "x" > f.txt && git add . && git commit -m "c"', { cwd: noRemotePath })
      const result = await pushBranch(noRemotePath, 'main')
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('no_remote')
    } finally {
      rmSync(noRemotePath, { recursive: true, force: true })
    }
  })

  it('pushes a new branch with --set-upstream and returns ok:true', async () => {
    execSync('git push origin HEAD:main', { cwd: repoPath })
    execSync('git checkout -b mc/run-test', { cwd: repoPath })
    writeFileSync(join(repoPath, 'pushed.ts'), 'export const x = 1')
    execSync('git add . && git commit -m "add pushed"', { cwd: repoPath })

    const result = await pushBranch(repoPath, 'mc/run-test')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.remoteBranch).toBe('origin/mc/run-test')

    const remoteBranches = execSync('git ls-remote --heads origin', { cwd: repoPath }).toString()
    expect(remoteBranches).toContain('mc/run-test')
  })

  it('pushes an existing tracked branch and returns ok:true', async () => {
    execSync('git push -u origin HEAD:main', { cwd: repoPath })
    writeFileSync(join(repoPath, 'update.ts'), 'export const y = 2')
    execSync('git add . && git commit -m "update"', { cwd: repoPath })

    const result = await pushBranch(repoPath, 'main')
    expect(result.ok).toBe(true)
  })
})

// ── getBranchSyncState ────────────────────────────────────────────────────────

describe('getBranchSyncState', () => {
  let repoPath: string
  let originPath: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = saveGitEnv()
    clearGitEnv()
    repoPath = mkdtempSync(join(tmpdir(), 'mc-ops-sync-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })

    originPath = mkdtempSync(join(tmpdir(), 'mc-ops-sync-origin-'))
    execSync('git init --bare', { cwd: originPath })
    execSync(`git remote add origin ${originPath}`, { cwd: repoPath })
    execSync('git push -u origin HEAD:main', { cwd: repoPath })
  })

  afterEach(() => {
    restoreGitEnv(savedEnv)
    rmSync(repoPath, { recursive: true, force: true })
    rmSync(originPath, { recursive: true, force: true })
  })

  it('returns exists:false for a branch that does not exist locally', async () => {
    const state = await getBranchSyncState(repoPath, 'feature/nonexistent')
    expect(state.exists).toBe(false)
    expect(state.existsOnRemote).toBe(false)
  })

  it('returns in-sync state (ahead:0, behind:0) for a freshly pushed branch', async () => {
    const state = await getBranchSyncState(repoPath, 'main')
    expect(state.exists).toBe(true)
    expect(state.existsOnRemote).toBe(true)
    expect(state.ahead).toBe(0)
    expect(state.behind).toBe(0)
  })

  it('reports ahead count for local commits not yet pushed', async () => {
    writeFileSync(join(repoPath, 'extra.ts'), 'export const z = 3')
    execSync('git add . && git commit -m "local only"', { cwd: repoPath })

    const state = await getBranchSyncState(repoPath, 'main')
    expect(state.exists).toBe(true)
    expect(state.existsOnRemote).toBe(true)
    expect(state.ahead).toBe(1)
    expect(state.behind).toBe(0)
  })

  it('returns existsOnRemote:false for a local-only branch', async () => {
    execSync('git checkout -b feature/local-only', { cwd: repoPath })
    const state = await getBranchSyncState(repoPath, 'feature/local-only')
    expect(state.exists).toBe(true)
    expect(state.existsOnRemote).toBe(false)
  })
})

// ── isMainCheckout ────────────────────────────────────────────────────────────

describe('isMainCheckout', () => {
  let repoPath: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = saveGitEnv()
    clearGitEnv()
    repoPath = mkdtempSync(join(tmpdir(), 'mc-ops-maincheckout-'))
    execSync('git init', { cwd: repoPath })
    execSync('git config user.email "test@test.com"', { cwd: repoPath })
    execSync('git config user.name "Test"', { cwd: repoPath })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: repoPath })
  })

  afterEach(() => {
    restoreGitEnv(savedEnv)
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('returns true for the main working tree', async () => {
    expect(await isMainCheckout(repoPath)).toBe(true)
  })

  it('returns false for a linked worktree created via git worktree add', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'mc-ops-wt-'))
    try {
      execSync(`git worktree add ${worktreePath} -b test-wt-branch`, { cwd: repoPath })
      expect(await isMainCheckout(worktreePath)).toBe(false)
    } finally {
      execSync(`git worktree remove --force ${worktreePath}`, { cwd: repoPath })
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  it('returns false for a directory that is not a git repo', async () => {
    const nonRepoDir = mkdtempSync(join(tmpdir(), 'mc-ops-nonrepo-'))
    try {
      expect(await isMainCheckout(nonRepoDir)).toBe(false)
    } finally {
      rmSync(nonRepoDir, { recursive: true, force: true })
    }
  })

  it('returns false for a path that does not exist', async () => {
    expect(await isMainCheckout('/tmp/this-path-does-not-exist-mc-test')).toBe(false)
  })

  it('returns true even when GIT_EDITOR and EDITOR are set in process.env', async () => {
    // Regression: simple-git's unsafe plugin rejects GIT_EDITOR/EDITOR,
    // so passing them through caused isMainCheckout to throw and return false.
    const savedEditor = process.env.EDITOR
    const savedGitEditor = process.env.GIT_EDITOR
    try {
      process.env.EDITOR = 'vim'
      process.env.GIT_EDITOR = 'nano'
      expect(await isMainCheckout(repoPath)).toBe(true)
    } finally {
      if (savedEditor === undefined) delete process.env.EDITOR
      else process.env.EDITOR = savedEditor
      if (savedGitEditor === undefined) delete process.env.GIT_EDITOR
      else process.env.GIT_EDITOR = savedGitEditor
    }
  })
})
