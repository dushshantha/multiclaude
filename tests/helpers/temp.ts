/**
 * Shared test helpers for temp directory and worktree lifecycle management.
 *
 * Usage: call `useTempDir()` at the top of a describe block. It registers
 * afterEach cleanup automatically so that temp dirs and worktrees are removed
 * even when test assertions fail.
 *
 * Cleanup order: worktrees first (git worktree remove + rmdir), then plain
 * dirs (repo dirs, origin dirs, etc.) — worktrees must be removed before the
 * parent repo is deleted so git can deregister them cleanly.
 */
import { afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

export interface WorktreeRef {
  path: string
  branch: string
}

export interface TempDirManager {
  /** Create a temp dir and register it for afterEach cleanup. */
  dir(prefix?: string): string
  /**
   * Create a temp dir, initialise a git repo inside it, and register for
   * afterEach cleanup.
   */
  repo(prefix?: string): string
  /**
   * Register a worktree (path + branch) for afterEach cleanup.
   * Safe to call even if the worktree has already been removed — cleanup is
   * idempotent.
   */
  trackWorktree(info: WorktreeRef, repoPath: string): void
}

/**
 * Call at describe scope (not inside an `it` block). Registers a single
 * afterEach hook that runs after every test in the enclosing describe.
 */
export function useTempDir(): TempDirManager {
  const dirs: string[] = []
  const worktrees: Array<WorktreeRef & { repoPath: string }> = []

  afterEach(async () => {
    // 1. Remove worktrees first — they need the parent repo to be alive so
    //    git can deregister the worktree entry.
    const wts = worktrees.splice(0)
    for (const { path, branch, repoPath } of wts) {
      try {
        execSync(`git worktree remove --force ${JSON.stringify(path)}`, {
          cwd: repoPath,
          stdio: 'pipe',
        })
      } catch {}
      try {
        execSync(`git branch -D ${JSON.stringify(branch)}`, {
          cwd: repoPath,
          stdio: 'pipe',
        })
      } catch {}
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }

    // 2. Remove plain dirs (repo dirs, origin bare repos, etc.) last.
    const ds = dirs.splice(0)
    for (const d of ds) {
      await rm(d, { recursive: true, force: true }).catch(() => {})
    }
  })

  function dir(prefix = 'mc-test-'): string {
    const p = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(p)
    return p
  }

  function repo(prefix = 'mc-test-'): string {
    const p = dir(prefix)
    execSync('git init', { cwd: p, stdio: 'pipe' })
    execSync('git config user.email "test@test.com"', { cwd: p, stdio: 'pipe' })
    execSync('git config user.name "Test"', { cwd: p, stdio: 'pipe' })
    execSync('echo "init" > README.md && git add . && git commit -m "init"', { cwd: p, stdio: 'pipe' })
    return p
  }

  function trackWorktree(info: WorktreeRef, repoPath: string): void {
    worktrees.push({ path: info.path, branch: info.branch, repoPath })
  }

  return { dir, repo, trackWorktree }
}
