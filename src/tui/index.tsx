import React, { useState, useEffect } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { exec } from 'child_process'
import { listTasks } from '../server/state/tasks.js'
import { listAgents } from '../server/state/agents.js'
import { listRuns } from '../server/state/runs.js'
import { workerLogPath } from '../spawner/index.js'
import { calculateCost } from '../server/cost.js'
import type { Task } from '../server/state/tasks.js'
import type Database from 'better-sqlite3'

const WEB_DASHBOARD_URL = 'http://localhost:3000'

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`
  exec(cmd)
}

interface LatestLogRow {
  task_id: string
  message: string
  level: string
  created_at: string
}

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '■',
  done: '✓',
  failed: '✗',
  cancelled: '–',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'white',
  in_progress: 'blue',
  done: 'green',
  failed: 'red',
  cancelled: 'gray',
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`
}

function getElapsedSeconds(startedAt: string): number {
  return (Date.now() - new Date(startedAt + 'Z').getTime()) / 1000
}

function formatTimeAgo(createdAt: string): string {
  const seconds = (Date.now() - new Date(createdAt + 'Z').getTime()) / 1000
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function isStuck(task: Task, log: LatestLogRow | undefined): boolean {
  if (!log) return false
  if (task.status === 'in_progress' && log.message.includes('stuck warning')) return true
  if (task.status === 'failed' && log.message.includes('no log activity')) return true
  return false
}

// Query the most recent log message per task in a single pass.
const LATEST_LOG_SQL = `
  SELECT task_id, message, level, created_at
  FROM logs
  WHERE id IN (SELECT MAX(id) FROM logs WHERE task_id IS NOT NULL GROUP BY task_id)
`

interface DashboardProps {
  db: Database.Database
  refreshMs?: number
}

function Dashboard({ db, refreshMs = 1000 }: DashboardProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [latestLogs, setLatestLogs] = useState<Map<string, LatestLogRow>>(new Map())
  const [runTickets, setRunTickets] = useState<Map<string, string>>(new Map())
  const { exit } = useApp()

  useEffect(() => {
    const refresh = () => {
      setTasks(listTasks(db))
      const rows = db.prepare(LATEST_LOG_SQL).all() as LatestLogRow[]
      setLatestLogs(new Map(rows.map(r => [r.task_id, r])))
      const runs = listRuns(db)
      const tickets = new Map<string, string>()
      for (const run of runs) {
        if (run.external_ref) tickets.set(run.id, run.external_ref)
      }
      setRunTickets(tickets)
    }
    refresh()
    const interval = setInterval(refresh, refreshMs)
    return () => clearInterval(interval)
  }, [db, refreshMs])

  useInput((input) => {
    if (input === 'q') exit()
    if (input === 'w') openBrowser(WEB_DASHBOARD_URL)
  })

  // suppress unused import warning
  void listAgents

  const running = tasks.filter(t => t.status === 'in_progress').length
  const done = tasks.filter(t => t.status === 'done').length
  const failed = tasks.filter(t => t.status === 'failed').length
  const totalTokens = tasks.reduce((sum, t) => sum + (t.total_tokens ?? 0), 0)
  const totalCost = tasks.reduce((sum, t) => {
    if (t.input_tokens == null && t.output_tokens == null) return sum
    return sum + calculateCost(t.input_tokens ?? 0, t.output_tokens ?? 0, 'sonnet')
  }, 0)

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>MultiClaude  </Text>
        <Text color="blue">■ {running} running  </Text>
        <Text color="green">✓ {done} done  </Text>
        {failed > 0 && <Text color="red">✗ {failed} failed  </Text>}
        {totalTokens > 0 && <Text dimColor>~{formatTokens(totalTokens)} tokens  </Text>}
        {totalCost > 0 && <Text dimColor>{formatCost(totalCost)}  </Text>}
        <Text dimColor>[q]uit  [w] web logs</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>{'TASK'.padEnd(28)} {'STATUS'.padEnd(12)} {'TIME'.padEnd(8)} {'TOKENS'.padEnd(8)} AGENT</Text>
        {tasks.map(t => {
          const icon = STATUS_ICONS[t.status] ?? '?'
          const color = STATUS_COLORS[t.status] ?? 'white'
          const log = latestLogs.get(t.id)
          const logMsg = log?.message?.replace(/\n/g, ' ').slice(0, 45)
          const stuck = isStuck(t, log)
          const ticket = t.run_id ? runTickets.get(t.run_id) : undefined

          let timeStr = '--'
          if (t.status === 'in_progress' && t.started_at) {
            timeStr = formatDuration(getElapsedSeconds(t.started_at))
          } else if (t.duration_seconds != null) {
            timeStr = formatDuration(t.duration_seconds)
          }

          const tokenStr = t.total_tokens != null ? formatTokens(t.total_tokens) : '--'
          // With ticket badge, title gets less space; without, full 27 chars
          const titleWidth = ticket ? 18 : 26
          const titleStr = t.title.slice(0, titleWidth).padEnd(titleWidth + 1)

          return (
            <Box key={t.id} flexDirection="column">
              <Box>
                <Text color={color}>{icon} </Text>
                {ticket && <Text dimColor>[{ticket}] </Text>}
                <Text color={color}>
                  {titleStr}
                </Text>
                <Text color={color}>
                  {t.status.padEnd(12)}{' '}
                </Text>
                <Text color={t.status === 'in_progress' ? 'yellow' : color}>
                  {timeStr.padEnd(8)}{' '}
                </Text>
                <Text dimColor>{tokenStr.padEnd(8)}{' '}</Text>
                <Text dimColor>{t.agent_id ?? '-'}</Text>
                {t.model === 'haiku' && (
                  <Text color="green">  [haiku]</Text>
                )}
                {t.model === 'opus' && (
                  <Text color="magenta">  [opus]</Text>
                )}
                {stuck && <Text color="yellow">  ⏱ stuck</Text>}
                {!stuck && t.retry_count > 0 && (
                  <Text color="yellow">  ⚠ retry {t.retry_count}/{t.max_retries}</Text>
                )}
              </Box>
              {t.status === 'in_progress' && t.agent_id && (
                <Box paddingLeft={3}>
                  {logMsg ? (
                    <Text dimColor>↳ {logMsg}{log?.created_at ? `  (last log ${formatTimeAgo(log.created_at)})` : ''}</Text>
                  ) : (
                    <Text dimColor>↳ tail -f {workerLogPath(t.agent_id)}</Text>
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export function startTui(db: Database.Database): void {
  render(<Dashboard db={db} />)
}
