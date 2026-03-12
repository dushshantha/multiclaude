import { spawn, execSync } from 'child_process'
import { platform } from 'os'

/**
 * Opens a terminal window that tails the worker's log file.
 *
 * Priority order:
 *   1. tmux new-window (if TMUX env var is set — cross-platform, zero deps)
 *   2. macOS Terminal.app via AppleScript (darwin only)
 *   3. macOS iTerm2 via AppleScript (darwin only, if running)
 *   4. Common Linux terminal emulators (gnome-terminal, xterm, konsole, etc.)
 *
 * Falls back gracefully: if no terminal can be opened, logs the tail command
 * so the user can manually open it.
 */
export function openWorkerTerminal(agentId: string, logPath: string): void {
  const title = `mc-${agentId}`
  const tailCmd = `tail -f '${logPath}'`

  // 1. tmux — works on any OS where tmux is installed
  if (process.env.TMUX) {
    try {
      execSync(`tmux new-window -n '${title}' '${tailCmd}'`, { stdio: 'pipe' })
      return
    } catch { /* not in tmux or tmux command failed */ }
  }

  const os = platform()

  if (os === 'darwin') {
    // 2. macOS Terminal.app (always available on macOS)
    try {
      const script = `tell application "Terminal"
        do script "${tailCmd.replace(/"/g, '\\"')}"
        activate
      end tell`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
      return
    } catch { /* osascript failed */ }
  }

  if (os === 'linux') {
    // 3. Common Linux terminal emulators — try in order
    const candidates: [string, string[]][] = [
      ['gnome-terminal', ['--title', title, '--', 'bash', '-c', `${tailCmd}; exec bash`]],
      ['xterm', ['-title', title, '-e', `${tailCmd}`]],
      ['konsole', ['--new-tab', '-p', `tabtitle=${title}`, '-e', `bash -c "${tailCmd}; exec bash"`]],
      ['xfce4-terminal', ['--title', title, '-e', `bash -c "${tailCmd}; exec bash"`]],
      ['mate-terminal', ['--title', title, '-e', `bash -c "${tailCmd}; exec bash"`]],
      ['lxterminal', ['--title', title, '-e', `bash -c "${tailCmd}; exec bash"`]],
    ]

    for (const [term, args] of candidates) {
      try {
        execSync(`which ${term}`, { stdio: 'pipe' })
        spawn(term, args, { detached: true, stdio: 'ignore' }).unref()
        return
      } catch { /* terminal not found or spawn failed */ }
    }
  }

  // Fallback: print the tail command so the user can open it manually
  console.log(`[multiclaude] Worker ${agentId} log: ${tailCmd}`)
}
