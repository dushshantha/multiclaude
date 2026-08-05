import { realpathSync } from 'fs'
import { resolve, dirname, basename, join } from 'path'

/**
 * Resolves a path to its real (symlink-free) path.
 * Unlike realpathSync, handles paths that do not exist yet by walking up
 * to the nearest existing ancestor, resolving that, then re-appending
 * the non-existent tail segments. This correctly handles /tmp → /private/tmp
 * on macOS for paths that haven't been created yet.
 */
function resolveWithFallback(p: string): string {
  const normalized = resolve(p)
  try {
    return realpathSync(normalized)
  } catch {
    // Non-existent path: resolve the nearest existing ancestor.
    const parts: string[] = []
    let current = normalized
    while (true) {
      try {
        const real = realpathSync(current)
        return parts.length === 0 ? real : join(real, ...parts.reverse())
      } catch {
        const parent = dirname(current)
        if (parent === current) break // reached filesystem root
        parts.push(basename(current))
        current = parent
      }
    }
    return normalized
  }
}

/**
 * Returns true when candidatePath is inside worktreeRoot.
 *
 * Handles:
 * - Relative paths (resolved via resolve())
 * - ".." traversal attacks
 * - Symlinks on both sides (e.g. /tmp → /private/tmp on macOS)
 * - Paths that do not exist yet (Write to a new file)
 * - Case-insensitive macOS filesystems (compares lowercased resolved paths)
 *
 * Denies (returns false) by default when the answer is unclear or an
 * exception occurs.
 */
export function isPathInWorktree(worktreeRoot: string, candidatePath: string): boolean {
  try {
    // Worktree root must exist — if realpathSync throws, deny.
    const resolvedRoot = realpathSync(resolve(worktreeRoot))
    const resolvedCandidate = resolveWithFallback(resolve(candidatePath))

    // Normalise for case-insensitive filesystems (macOS HFS+/APFS default).
    const rootLower = resolvedRoot.toLowerCase()
    const candidateLower = resolvedCandidate.toLowerCase()

    // The candidate must equal the root or be strictly inside it.
    // Appending '/' prevents prefix-collision: /tmp/mc-abc would otherwise
    // falsely match /tmp/mc-abcdef.
    return candidateLower === rootLower || candidateLower.startsWith(rootLower + '/')
  } catch {
    return false
  }
}
