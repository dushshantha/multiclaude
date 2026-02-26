import { simpleGit } from 'simple-git'

const INTEGRATION_BRANCH = 'mc/integration'

export async function ensureIntegrationBranch(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath)
  const branches = await git.branchLocal()
  if (!branches.all.includes(INTEGRATION_BRANCH)) {
    const current = branches.current
    await git.checkoutBranch(INTEGRATION_BRANCH, 'HEAD')
    await git.checkout(current)
  }
}

export async function mergeWorktreeBranch(repoPath: string, branch: string): Promise<void> {
  const git = simpleGit(repoPath)
  const current = (await git.branchLocal()).current
  await git.checkout(INTEGRATION_BRANCH)
  await git.merge([branch, '--no-ff', '-m', `merge: ${branch} into integration`])
  await git.checkout(current)
}
