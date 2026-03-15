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
 */
export function branchNameFromTitle(title: string): string {
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
  return `${prefix}/${slug}`
}

export async function createWorktree(repoPath: string, taskId: string, taskTitle?: string): Promise<WorktreeInfo> {
  const branch = taskTitle ? branchNameFromTitle(taskTitle) : `mc/${taskId}`
  const worktreePath = mkdtempSync(join(tmpdir(), `mc-${taskId}-`))
  const git = simpleGit(repoPath)
  await git.raw(['worktree', 'add', '-b', branch, worktreePath])
  return { path: worktreePath, branch, taskId }
}

export async function removeWorktree(repoPath: string, info: WorktreeInfo): Promise<void> {
  const git = simpleGit(repoPath)
  await git.raw(['worktree', 'remove', '--force', info.path])
  await git.raw(['branch', '-D', info.branch]).catch(() => {})
  await rm(info.path, { recursive: true, force: true }).catch(() => {})
}
