import { simpleGit } from 'simple-git'

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
    const current = branches.current
    await git.checkoutBranch(branch, 'HEAD')
    await git.checkout(current)
  }
}

export async function mergeWorktreeBranch(repoPath: string, branch: string, runId?: string): Promise<void> {
  const git = simpleGit(repoPath)
  const integBranch = getIntegBranch(runId)
  const current = (await git.branchLocal()).current
  await git.checkout(integBranch)
  try {
    await git.merge([branch, '--no-ff', '-m', `merge: ${branch} into ${integBranch}`])
  } catch (mergeErr) {
    const conflictedStr = await git.raw(['diff', '--name-only', '--diff-filter=U'])
    const conflicted = conflictedStr.trim().split('\n').filter(Boolean)
    const lockFiles = ['package-lock.json', 'package.json']
    const nonLockConflicts = conflicted.filter(f => !lockFiles.includes(f))

    if (nonLockConflicts.length > 0) {
      await git.raw(['merge', '--abort'])
      await git.checkout(current)
      throw mergeErr
    }

    // Auto-resolve package lock file add/add conflicts by taking theirs
    const filesToResolve = lockFiles.filter(f => conflicted.includes(f))
    if (filesToResolve.length > 0) {
      await git.raw(['checkout', '--theirs', ...filesToResolve])
      await git.raw(['add', ...filesToResolve])
    }
    await git.raw(['commit', '--no-edit'])
  }
  await git.checkout(current)
}
