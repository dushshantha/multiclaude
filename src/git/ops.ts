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

// simple-git's "unsafe" plugin rejects GIT_EDITOR and EDITOR, making every
// call throw. Strip them along with the worktree-isolation vars.
const EXCLUDED_ENV_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_EDITOR',
  'EDITOR',
])

/**
 * Create a simple-git instance that always operates on the repo at `repoPath`,
 * ignoring any GIT_DIR / GIT_WORK_TREE / GIT_CEILING_DIRECTORIES that the
 * parent process may have set (e.g. when running inside a git worktree).
 */
function git(repoPath: string): ReturnType<typeof simpleGit> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !EXCLUDED_ENV_VARS.has(k)) {
      env[k] = v
    }
  }
  return simpleGit(repoPath).env(env)
}

export async function checkIsGitRepo(repoPath: string): Promise<boolean> {
  try {
    return await git(repoPath).checkIsRepo()
  } catch {
    return false
  }
}

/**
 * Returns true only when `dir` is the main working tree of a git repository,
 * not a linked worktree. Compares `git rev-parse --git-dir` with
 * `git rev-parse --git-common-dir` — they are equal in the main checkout
 * and differ in a linked worktree. Returns false when `dir` is not a git repo
 * or does not exist; re-throws unexpected errors so callers are not silently
 * misled when a false value now blocks worker spawning.
 */
export async function isMainCheckout(dir: string): Promise<boolean> {
  try {
    const g = git(dir)
    const [gitDir, commonDir] = await Promise.all([
      g.raw(['rev-parse', '--git-dir']),
      g.raw(['rev-parse', '--git-common-dir']),
    ])
    return gitDir.trim() === commonDir.trim()
  } catch (err) {
    // Not a git repo or doesn't exist — return false.
    const msg = err instanceof Error ? err.message : String(err)
    if (/not a git repository|does not exist|no such file/i.test(msg)) return false
    // Re-throw anything else so unexpected failures don't silently block spawning.
    throw err
  }
}

export async function hasRemote(repoPath: string): Promise<boolean> {
  // Use --local to avoid picking up a global [remote "origin"] from ~/.gitconfig
  try {
    const url = (await git(repoPath).raw(['config', '--local', '--get', 'remote.origin.url'])).trim()
    return url.length > 0
  } catch {
    return false
  }
}

export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  // Use --local to avoid picking up a global [remote "origin"] from ~/.gitconfig
  try {
    const url = (await git(repoPath).raw(['config', '--local', '--get', 'remote.origin.url'])).trim()
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

  const g = git(repoPath)
  try {
    await g.push('origin', branch)
    return { ok: true, remoteBranch: `origin/${branch}` }
  } catch {
    // Plain push failed — try with --set-upstream (first push of a new branch)
    try {
      await g.raw(['push', '--set-upstream', 'origin', branch])
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
  const g = git(repoPath)

  // Best-effort fetch; degrade if origin is unreachable
  try {
    await g.fetch('origin')
  } catch {
    // fall through
  }

  // Check local branch existence
  let exists = false
  try {
    const localBranches = await g.branchLocal()
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
    const remoteBranches = await g.branch(['-r'])
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
    const revList = (await g.raw(['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`])).trim()
    const parts = revList.split(/\s+/)
    behind = parseInt(parts[0] ?? '0', 10) || 0
    ahead = parseInt(parts[1] ?? '0', 10) || 0
  } catch {
    // can't determine counts
  }

  return { exists, existsOnRemote, ahead, behind }
}
