import { simpleGit } from 'simple-git'
import { mkdtempSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, isAbsolute, resolve } from 'path'

export interface ReconcileAction {
  type: 'prune' | 'remove-worktree' | 'delete-branch' | 'allocate-suffix'
  target: string
  detail: string
}

export interface WorktreeInfo {
  path: string
  branch: string
  taskId: string
  gitDir: string
  headSha: string
  reconcileActions: ReconcileAction[]
  priorBranch?: string
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'use', 'using'])

const PROTECTED_BRANCH_RE = /^(main|master)$|^mc\/run-/

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCH_RE.test(branch)
}

/**
 * Derive a git branch name from a task title.
 * Prefix is 'fix/' when the title indicates a fix/bug/patch, otherwise 'feature/'.
 * The slug is 2-3 meaningful lowercase words derived from the title.
 * If taskId is provided, appends a short identifier to ensure uniqueness.
 */
export function branchNameFromTitle(title: string, taskId?: string): string {
  const lower = title.toLowerCase()

  // Detect fix prefix before stripping conventional commit prefix
  const isFix = /^(fix|bug|patch|hotfix)[:/]|\b(bugfix|hotfix)\b/.test(lower)
  const prefix = isFix ? 'fix' : 'feature'

  // Strip conventional commit prefix (e.g. "feat:", "fix:", "chore: ")
  const stripped = lower.replace(/^[a-z]+[:/]\s*/i, '')

  // Normalize to words: keep only alphanumeric, split on anything else
  const words = stripped
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w))
    .slice(0, 3)

  const slug = words.length > 0 ? words.join('-') : 'task'

  // Append taskId suffix for uniqueness if provided
  if (taskId) {
    // Use the last part after dash (usually a number) for uniqueness, or first 4 chars
    const parts = taskId.split(/[-_]/)
    const taskIdPart = parts.length > 1 ? parts[parts.length - 1] : taskId.substring(0, 4)
    return `${prefix}/${slug}-${taskIdPart}`
  }

  return `${prefix}/${slug}`
}

export function readWorktreeGitDir(worktreePath: string): string {
  const dotGitPath = join(worktreePath, '.git')
  const content = readFileSync(dotGitPath, 'utf8').trim()
  const match = content.match(/^gitdir:\s*(.+)$/m)
  if (!match) {
    throw new Error(`${dotGitPath} does not contain a valid gitdir reference`)
  }
  const gitDir = match[1].trim()
  return isAbsolute(gitDir) ? gitDir : resolve(worktreePath, gitDir)
}

export async function preflightReconcile(
  git: ReturnType<typeof simpleGit>,
  branch: string,
  baseBranch?: string,
): Promise<{ actions: ReconcileAction[]; branch: string; priorBranch?: string }> {
  const actions: ReconcileAction[] = []

  if (isProtectedBranch(branch)) {
    throw new Error(`Refusing to reconcile protected branch: ${branch}`)
  }

  const currentBranch = (await git.raw(['branch', '--show-current']).catch(() => '')).trim()
  if (currentBranch && branch === currentBranch) {
    throw new Error(`Refusing to reconcile the repository's checked-out branch: ${branch}`)
  }

  // Step 1: Prune stale worktrees and check if branch exists
  await git.raw(['worktree', 'prune'])

  const branchExists = (await git.raw(['branch', '--list', branch]).catch(() => '')).trim()
  if (!branchExists) {
    return { actions, branch }
  }

  // Branch exists — full reconcile: check worktree state before and after prune
  const worktreeList = await git.raw(['worktree', 'list', '--porcelain'])

  // Step 2: If a worktree is still registered for this branch, remove it when clean
  const existingPath = parseWorktreePathForBranch(worktreeList, branch)
  if (existingPath) {
    let removed = false
    try {
      const wtGit = simpleGit(existingPath)
      const status = await wtGit.status()
      if (status.isClean()) {
        await git.raw(['worktree', 'remove', existingPath])
        await rm(existingPath, { recursive: true, force: true }).catch(() => {})
        actions.push({ type: 'remove-worktree', target: existingPath, detail: `Removed clean worktree at ${existingPath}` })
        removed = true
      }
    } catch {
      // Directory inaccessible or corrupt — force remove the entry
      await git.raw(['worktree', 'remove', '--force', existingPath]).catch(async () => {
        await git.raw(['worktree', 'prune'])
      })
      await rm(existingPath, { recursive: true, force: true }).catch(() => {})
      actions.push({ type: 'remove-worktree', target: existingPath, detail: `Force-removed inaccessible worktree at ${existingPath}` })
      removed = true
    }

    if (!removed) {
      // Worktree has uncommitted changes — preserve it, allocate new branch
      const newBranch = await allocateSuffixedBranch(git, branch)
      actions.push({
        type: 'allocate-suffix',
        target: newBranch,
        detail: `Worktree at ${existingPath} has uncommitted changes; preserved ${branch}, allocated ${newBranch}`,
      })
      return { actions, branch: newBranch, priorBranch: branch }
    }
  }

  // Step 3: Branch exists but no worktree — check for unique commits vs base
  const baseRef = baseBranch || 'HEAD'
  let uniqueCount = 0
  try {
    const uniqueLog = (await git.raw(['log', '--oneline', `${baseRef}..${branch}`])).trim()
    uniqueCount = uniqueLog ? uniqueLog.split('\n').filter(Boolean).length : 0
  } catch {
    uniqueCount = -1
  }

  if (uniqueCount === 0) {
    await git.raw(['branch', '-D', branch])
    actions.push({ type: 'delete-branch', target: branch, detail: `Deleted branch ${branch} (no unique commits vs ${baseRef})` })
  } else {
    const newBranch = await allocateSuffixedBranch(git, branch)
    const countMsg = uniqueCount > 0 ? `${uniqueCount} unique commit(s)` : 'could not determine commit count'
    actions.push({
      type: 'allocate-suffix',
      target: newBranch,
      detail: `Preserved ${branch} (${countMsg}); allocated ${newBranch}`,
    })
    return { actions, branch: newBranch, priorBranch: branch }
  }

  return { actions, branch }
}

export async function createWorktree(repoPath: string, taskId: string, taskTitle?: string, baseBranch?: string): Promise<WorktreeInfo> {
  let branch = taskTitle ? branchNameFromTitle(taskTitle, taskId) : `mc/${taskId}`
  const git = simpleGit(repoPath)

  const reconcile = await preflightReconcile(git, branch, baseBranch)
  branch = reconcile.branch

  const worktreePath = mkdtempSync(join(tmpdir(), `mc-${taskId}-`))

  if (baseBranch) {
    await git.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch])
  } else {
    await git.raw(['worktree', 'add', '-b', branch, worktreePath])
  }

  const gitDir = readWorktreeGitDir(worktreePath)
  const worktreeGit = simpleGit(worktreePath)
  const headSha = (await worktreeGit.revparse(['HEAD'])).trim()

  return {
    path: worktreePath,
    branch,
    taskId,
    gitDir,
    headSha,
    reconcileActions: reconcile.actions,
    priorBranch: reconcile.priorBranch,
  }
}

function parseWorktreePathForBranch(porcelainOutput: string, branch: string): string | null {
  const entries = porcelainOutput.split('\n\n')
  for (const entry of entries) {
    if (entry.includes(`branch refs/heads/${branch}`)) {
      const pathLine = entry.split('\n').find(l => l.startsWith('worktree '))
      if (pathLine) return pathLine.slice('worktree '.length)
    }
  }
  return null
}

async function allocateSuffixedBranch(
  git: ReturnType<typeof simpleGit>,
  branch: string,
): Promise<string> {
  for (let i = 2; i <= 100; i++) {
    const candidate = `${branch}-attempt-${i}`
    const exists = (await git.raw(['branch', '--list', candidate]).catch(() => '')).trim()
    if (!exists) return candidate
  }
  throw new Error(`Could not allocate suffixed branch name for ${branch} after 100 attempts`)
}

/**
 * Removes any stray `core.worktree` from the parent repository's shared git
 * config. Workers receive GIT_DIR/GIT_WORK_TREE env vars for isolation, but
 * if anything writes `core.worktree` to the shared .git/config, the parent
 * repo breaks when the temp worktree directory is deleted.
 */
export async function sanitizeParentGitConfig(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath)
  try {
    const value = (await git.raw(['config', '--local', '--get', 'core.worktree'])).trim()
    if (value) {
      await git.raw(['config', '--local', '--unset', 'core.worktree'])
    }
  } catch {
    // exit code 1 = key not found — the expected state
  }
}

/**
 * Asserts that the parent repository's shared git config does not contain
 * `core.worktree`. Throws if it does — this key should never be in the
 * shared config when using the worktree isolation model.
 */
export async function assertSharedConfigClean(repoPath: string): Promise<void> {
  const git = simpleGit(repoPath)
  let value: string | undefined
  try {
    value = (await git.raw(['config', '--local', '--get', 'core.worktree'])).trim()
  } catch {
    return
  }
  if (value) {
    throw new Error(
      `Shared git config at ${repoPath} contains core.worktree=${value}. ` +
      `This corrupts the repository when the worktree is deleted. ` +
      `Use environment variables (GIT_DIR, GIT_WORK_TREE) for isolation instead.`
    )
  }
}

export async function removeWorktree(repoPath: string, info: Pick<WorktreeInfo, 'path' | 'branch'>): Promise<void> {
  const git = simpleGit(repoPath)
  // Silently ignore errors when the worktree is already gone (idempotent)
  await git.raw(['worktree', 'remove', '--force', info.path]).catch(() => {})
  await git.raw(['branch', '-D', info.branch]).catch(() => {})
  await rm(info.path, { recursive: true, force: true }).catch(() => {})
  await sanitizeParentGitConfig(repoPath).catch(() => {})
}
