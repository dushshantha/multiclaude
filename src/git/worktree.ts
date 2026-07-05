import { simpleGit } from 'simple-git'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export interface WorktreeInfo {
  path: string
  branch: string
  taskId: string
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'use', 'using'])

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

export async function createWorktree(repoPath: string, taskId: string, taskTitle?: string, baseBranch?: string): Promise<WorktreeInfo> {
  const branch = taskTitle ? branchNameFromTitle(taskTitle, taskId) : `mc/${taskId}`
  const worktreePath = mkdtempSync(join(tmpdir(), `mc-${taskId}-`))
  const git = simpleGit(repoPath)

  // Clean up stale worktree/branch from a prior failed attempt (idempotent)
  const worktreeList = await git.raw(['worktree', 'list', '--porcelain'])
  const staleWorktreePath = parseWorktreePathForBranch(worktreeList, branch)
  if (staleWorktreePath) {
    await git.raw(['worktree', 'remove', '--force', staleWorktreePath]).catch(() => {})
    await rm(staleWorktreePath, { recursive: true, force: true }).catch(() => {})
  }
  await git.raw(['branch', '-D', branch]).catch(() => {})

  if (baseBranch) {
    await git.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch])
  } else {
    await git.raw(['worktree', 'add', '-b', branch, worktreePath])
  }
  return { path: worktreePath, branch, taskId }
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

export async function removeWorktree(repoPath: string, info: WorktreeInfo): Promise<void> {
  const git = simpleGit(repoPath)
  // Silently ignore errors when the worktree is already gone (idempotent)
  await git.raw(['worktree', 'remove', '--force', info.path]).catch(() => {})
  await git.raw(['branch', '-D', info.branch]).catch(() => {})
  await rm(info.path, { recursive: true, force: true }).catch(() => {})
}
