#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook entrypoint.
 *
 * Invocation:
 *   node dist/spawner/worktree-guard-hook.js [worktree-root]
 *
 * Environment:
 *   MULTICLAUDE_WORKTREE  — absolute path to the worker's worktree root
 *   MULTICLAUDE_TASK_ID   — task identifier (used in violation log)
 *
 * The worktree root can also be supplied as the first positional argument
 * (argv[2]) for contexts where env vars are unavailable.
 *
 * Reads a Claude Code hook JSON payload from stdin, extracts the target
 * file path for Write / Edit / Read / NotebookEdit tool calls, and denies
 * the tool invocation when the path falls outside the worktree.
 *
 * Deny signal: exits with code 2 and writes {"reason": "..."} to stdout.
 * On deny, also appends a structured line to .claude/boundary-violations.log
 * inside the worktree so violations are observable.
 */

import { readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { isPathInWorktree } from './worktree-guard.js'

interface HookPayload {
  session_id?: string
  transcript_path?: string
  // Flat format (most common)
  tool_name?: string
  tool_input?: Record<string, unknown>
  // Nested format (alternative)
  tool_use?: {
    name: string
    input: Record<string, unknown>
  }
}

interface ViolationEntry {
  timestamp: string
  tool: string
  path: string
  taskId: string
}

function extractTargetPaths(toolName: string, toolInput: Record<string, unknown>): string[] {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'Read':
      if (typeof toolInput.file_path === 'string') return [toolInput.file_path]
      break
    case 'NotebookEdit':
      if (typeof toolInput.notebook_path === 'string') return [toolInput.notebook_path]
      break
  }
  return []
}

function logViolation(worktreeRoot: string, entry: ViolationEntry): void {
  try {
    const logDir = join(worktreeRoot, '.claude')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(join(logDir, 'boundary-violations.log'), JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // Never let log failures prevent the deny from propagating.
  }
}

function deny(reason: string): never {
  process.stdout.write(JSON.stringify({ reason }) + '\n')
  process.exit(2)
}

function main(): void {
  const worktreeRoot = process.env.MULTICLAUDE_WORKTREE ?? process.argv[2]
  const taskId = process.env.MULTICLAUDE_TASK_ID ?? 'unknown'

  if (!worktreeRoot) {
    // Not running in a worker context — allow everything through.
    process.exit(0)
  }

  let raw: string
  try {
    raw = readFileSync('/dev/stdin', 'utf-8')
  } catch {
    // Can't read stdin; allow through rather than blocking blindly.
    process.exit(0)
  }

  let payload: HookPayload
  try {
    payload = JSON.parse(raw) as HookPayload
  } catch {
    process.exit(0)
  }

  // Normalise both payload shapes into a single (toolName, toolInput) pair.
  const toolName = payload.tool_name ?? payload.tool_use?.name ?? ''
  const toolInput = payload.tool_input ?? payload.tool_use?.input ?? {}

  const paths = extractTargetPaths(toolName, toolInput)

  for (const targetPath of paths) {
    if (!isPathInWorktree(worktreeRoot, targetPath)) {
      logViolation(worktreeRoot, {
        timestamp: new Date().toISOString(),
        tool: toolName,
        path: targetPath,
        taskId,
      })
      deny(
        `Boundary violation: ${toolName} attempted to access "${targetPath}" which is outside the assigned worktree "${worktreeRoot}". Worker agents must stay within their worktree.`,
      )
    }
  }

  process.exit(0)
}

main()
