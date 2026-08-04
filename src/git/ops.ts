import { simpleGit } from 'simple-git'

export type PushFailureReason = 'no_remote' | 'auth_failed' | 'non_fast_forward' | 'branch_missing' | 'push_failed'

export type PushResult =
  | { ok: true; remoteBranch: string }
  | { ok: false; reason: PushFailureReason; detail: string }

/**
 * Classify a push failure from git stderr text into a stable slug.
 * Exported so tests can verify classification without a network.
 */
export function classifyPushFailure(stderr: string): PushFailureReason {
  if (/non-fast-forward|rejected/.test(stderr)) return 'non_fast_forward'
  if (/Permission denied|Authentication failed|could not read Username/.test(stderr)) return 'auth_failed'
  if (/src refspec.*does not match|does not match any/.test(stderr)) return 'branch_missing'
  return 'push_failed'
}

export async function hasRemote(repoPath: string): Promise<boolean> {
  const git = simpleGit(repoPath)
  try {
    const remotes = await git.getRemotes()
    return remotes.some(r => r.name === 'origin')
  } catch {
    return false
  }
}

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath)
  try {
    const url = (await git.remote(['get-url', 'origin']) as string).trim()
    return url || null
  } catch {
    return null
  }
}

/**
 * Parse a GitHub remote URL into { owner, repo }.
 * Handles SSH (git@github.com:owner/repo.git) and HTTPS (https://github.com/owner/repo.git).
 * Strips trailing .git. Returns null for non-GitHub remotes — never throws.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] }

  const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] }

  return null
}

/**
 * Push a branch to origin. Returns a typed PushResult — never throws for
 * expected failures. Tries plain push first, then --set-upstream on failure.
 */
export async function pushBranch(repoPath: string, branch: string): Promise<PushResult> {
  const remote = await hasRemote(repoPath)
  if (!remote) {
    return { ok: false, reason: 'no_remote', detail: 'No origin remote configured' }
  }

  const git = simpleGit(repoPath)
  try {
    await git.push('origin', branch)
    return { ok: true, remoteBranch: `origin/${branch}` }
  } catch {
    // Plain push failed — try with --set-upstream (first push of a new branch)
    try {
      await git.raw(['push', '--set-upstream', 'origin', branch])
      return { ok: true, remoteBranch: `origin/${branch}` }
    } catch (err2) {
      const detail = err2 instanceof Error ? err2.message : String(err2)
      return { ok: false, reason: classifyPushFailure(detail), detail }
    }
  }
}

/**
 * Compare a local branch to its upstream on origin.
 * Fetches from origin first; degrades gracefully on fetch failure.
 */
export async function getBranchSyncState(
  repoPath: string,
  branch: string,
): Promise<{ exists: boolean; existsOnRemote: boolean; ahead: number; behind: number }> {
  const git = simpleGit(repoPath)

  // Best-effort fetch; degrade if origin is unreachable
  try {
    await git.fetch('origin')
  } catch {
    // fall through
  }

  // Check local branch existence
  let exists = false
  try {
    const localBranches = await git.branchLocal()
    exists = localBranches.all.includes(branch)
  } catch {
    // can't determine
  }

  if (!exists) {
    return { exists: false, existsOnRemote: false, ahead: 0, behind: 0 }
  }

  // Check remote branch existence
  let existsOnRemote = false
  try {
    const remoteBranches = await git.branch(['-r'])
    existsOnRemote = remoteBranches.all.some(
      b => b.trim() === `origin/${branch}` || b.trim().endsWith(`/origin/${branch}`),
    )
  } catch {
    // degrade
  }

  if (!existsOnRemote) {
    return { exists, existsOnRemote: false, ahead: 0, behind: 0 }
  }

  let ahead = 0
  let behind = 0
  try {
    const revList = (await git.raw(['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`])).trim()
    const parts = revList.split(/\s+/)
    behind = parseInt(parts[0] ?? '0', 10) || 0
    ahead = parseInt(parts[1] ?? '0', 10) || 0
  } catch {
    // can't determine counts
  }

  return { exists, existsOnRemote, ahead, behind }
}
