import { simpleGit } from 'simple-git'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { pushBranch, type PushResult } from './ops.js'

export class MergeConflictError extends Error {
  constructor(
    public readonly taskBranch: string,
    public readonly integBranch: string,
    public readonly conflictedFiles: string[],
  ) {
    super(`Merge conflict: ${taskBranch} cannot be merged into ${integBranch} — conflicted files: ${conflictedFiles.join(', ')}`)
    this.name = 'MergeConflictError'
  }
}

export const RUN_INTEGRATION_BRANCH = (runId: string) => `mc/run-${runId}`
const FALLBACK_INTEGRATION_BRANCH = 'mc/integration'

function getIntegBranch(runId?: string): string {
  return runId ? RUN_INTEGRATION_BRANCH(runId) : FALLBACK_INTEGRATION_BRANCH
}

const AUTO_RESOLVABLE_FILES = new Set([
  'package-lock.json',
  'package.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'shrinkwrap.json',
  'npm-shrinkwrap.json',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'composer.lock',
  'Cargo.lock',
  'go.sum',
  'go.mod',
])

export function isAutoResolvable(filePath: string): boolean {
  const name = basename(filePath)
  return AUTO_RESOLVABLE_FILES.has(name) || name.endsWith('.lock')
}

async function getConflictedFiles(git: ReturnType<typeof simpleGit>): Promise<string[]> {
  const raw = await git.raw(['diff', '--name-only', '--diff-filter=U'])
  return raw.trim().split('\n').filter(Boolean)
}

async function autoResolveConflicts(
  git: ReturnType<typeof simpleGit>,
  conflicted: string[],
  strategy: 'ours' | 'theirs',
): Promise<string[]> {
  const resolvable = conflicted.filter(f => isAutoResolvable(f))
  const unresolvable = conflicted.filter(f => !isAutoResolvable(f))

  if (resolvable.length > 0) {
    await git.raw(['checkout', `--${strategy}`, ...resolvable])
    await git.raw(['add', ...resolvable])
  }

  return unresolvable
}

async function isAncestorOf(
  git: ReturnType<typeof simpleGit>,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    const ancestorSha = (await git.revparse([ancestor])).trim()
    const descendantSha = (await git.revparse([descendant])).trim()
    if (ancestorSha === descendantSha) return true
    const mergeBase = (await git.raw(['merge-base', ancestor, descendant])).trim()
    return mergeBase === ancestorSha
  } catch {
    return false
  }
}

/**
 * Check whether a task branch has been merged into the integration branch.
 * Robust to deleted local task branches: tries the local ref first, then
 * origin/<taskBranch> as a fallback, so it succeeds even when cleanup has
 * already removed the local branch. Returns false (never throws) when neither
 * ref resolves — that is the conservative safe default.
 */
export async function isMergedInto(
  repoPath: string,
  taskBranch: string,
  integBranch: string,
): Promise<boolean> {
  const git = simpleGit(repoPath)
  const candidates = [taskBranch, `origin/${taskBranch}`]

  for (const ref of candidates) {
    try {
      const ancestorSha = (await git.revparse([ref])).trim()
      const descendantSha = (await git.revparse([integBranch])).trim()
      if (ancestorSha === descendantSha) return true
      const mergeBase = (await git.raw(['merge-base', ancestorSha, descendantSha])).trim()
      if (mergeBase === ancestorSha) return true
    } catch {
      // ref doesn't exist or merge-base failed; try next candidate
    }
  }

  return false
}

export async function ensureIntegrationBranch(repoPath: string, runId?: string): Promise<void> {
  const git = simpleGit(repoPath)
  const branch = getIntegBranch(runId)
  const branches = await git.branchLocal()
  if (!branches.all.includes(branch)) {
    await git.raw(['branch', branch, 'HEAD'])
  }
}

const mergeLocks = new Map<string, Promise<void>>()

export async function mergeWorktreeBranch(
  repoPath: string,
  branch: string,
  runId?: string,
  taskWorktreePath?: string,
): Promise<{ push: PushResult }> {
  const key = getIntegBranch(runId)
  const prev = mergeLocks.get(key) ?? Promise.resolve()
  let resolve!: () => void
  const next = new Promise<void>(r => { resolve = r })
  mergeLocks.set(key, next)
  try {
    await prev

    const git = simpleGit(repoPath)
    const integBranch = key

    // Step 1: Bring task branch up to date with integration branch.
    // Merges the integration branch into the task branch so it integrates
    // against the latest state rather than a stale base.
    if (taskWorktreePath) {
      const upToDate = await isAncestorOf(git, integBranch, branch)
      if (!upToDate) {
        const taskGit = simpleGit(taskWorktreePath)
        try {
          await taskGit.raw(['merge', integBranch, '-m', `update: merge ${integBranch} into ${branch}`])
        } catch {
          const conflicted = await getConflictedFiles(taskGit)
          const unresolvable = await autoResolveConflicts(taskGit, conflicted, 'ours')
          if (unresolvable.length > 0) {
            try { await taskGit.raw(['merge', '--abort']) } catch {}
            throw new MergeConflictError(integBranch, branch, unresolvable)
          }
          await taskGit.raw(['commit', '-m', `update: merge ${integBranch} into ${branch}`])
        }
      }
    }

    // Step 2: Merge updated task branch into integration branch
    const tmpDir = mkdtempSync(join(tmpdir(), 'mc-merge-'))
    await git.raw(['worktree', 'add', tmpDir, integBranch])

    try {
      const tmpGit = simpleGit(tmpDir)
      try {
        await tmpGit.merge([branch, '--no-ff', '-m', `merge: ${branch} into ${integBranch}`])
      } catch (mergeErr) {
        const conflicted = await getConflictedFiles(tmpGit)
        const unresolvable = await autoResolveConflicts(tmpGit, conflicted, 'theirs')

        if (unresolvable.length > 0) {
          try { await tmpGit.raw(['merge', '--abort']) } catch {}
          throw new MergeConflictError(branch, integBranch, unresolvable)
        }

        await tmpGit.raw(['commit', '-m', `merge: ${branch} into ${integBranch}`])
      }
    } finally {
      await git.raw(['worktree', 'remove', '--force', tmpDir])
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }

    // Verify the task branch is now an ancestor of the integration branch
    const merged = await isAncestorOf(git, branch, integBranch)
    if (!merged) {
      throw new Error(`Merge verification failed: ${branch} is not an ancestor of ${integBranch} after merge`)
    }

    // Push integration branch to origin so the orchestrator can create a PR.
    // Push failures are returned to the caller — never thrown — so an otherwise
    // successful merge is not rolled back due to a transient network issue.
    const push = await pushBranch(repoPath, integBranch)
    return { push }
  } finally {
    resolve()
    if (mergeLocks.get(key) === next) {
      mergeLocks.delete(key)
    }
  }
}
