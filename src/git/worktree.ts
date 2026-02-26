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

export async function createWorktree(repoPath: string, taskId: string): Promise<WorktreeInfo> {
  const branch = `mc/${taskId}`
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
