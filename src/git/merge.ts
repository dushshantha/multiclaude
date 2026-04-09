import { simpleGit } from 'simple-git'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export const RUN_INTEGRATION_BRANCH = (runId: string) => `mc/run-${runId}`
const FALLBACK_INTEGRATION_BRANCH = 'mc/integration'

function getIntegBranch(runId?: string): string {
  return runId ? RUN_INTEGRATION_BRANCH(runId) : FALLBACK_INTEGRATION_BRANCH
}

export async function ensureIntegrationBranch(repoPath: string, runId?: string): Promise<void> {
  const git = simpleGit(repoPath)
  const branch = getIntegBranch(runId)
  const branches = await git.branchLocal()
  if (!branches.all.includes(branch)) {
    // Create branch from HEAD without checking it out — safe with uncommitted changes
    await git.raw(['branch', branch, 'HEAD'])
  }
}

export async function mergeWorktreeBranch(repoPath: string, branch: string, runId?: string): Promise<void> {
  const git = simpleGit(repoPath)
  const integBranch = getIntegBranch(runId)

  // Create a temp worktree on the integration branch so we never touch the main repo's working tree
  const tmpDir = mkdtempSync(join(tmpdir(), 'mc-merge-'))
  await git.raw(['worktree', 'add', tmpDir, integBranch])

  try {
    const tmpGit = simpleGit(tmpDir)
    try {
      await tmpGit.merge([branch, '--no-ff', '-m', `merge: ${branch} into ${integBranch}`])
    } catch (mergeErr) {
      const conflictedStr = await tmpGit.raw(['diff', '--name-only', '--diff-filter=U'])
      const conflicted = conflictedStr.trim().split('\n').filter(Boolean)
      const lockFiles = ['package-lock.json', 'package.json']
      const nonLockConflicts = conflicted.filter(f => !lockFiles.includes(f))

      if (nonLockConflicts.length > 0) {
        await tmpGit.raw(['merge', '--abort'])
        throw mergeErr
      }

      // Auto-resolve package lock file add/add conflicts by taking theirs
      const filesToResolve = lockFiles.filter(f => conflicted.includes(f))
      if (filesToResolve.length > 0) {
        await tmpGit.raw(['checkout', '--theirs', ...filesToResolve])
        await tmpGit.raw(['add', ...filesToResolve])
      }
      await tmpGit.raw(['commit', '-m', `merge: ${branch} into ${integBranch}`])
    }
  } finally {
    await git.raw(['worktree', 'remove', '--force', tmpDir])
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}
