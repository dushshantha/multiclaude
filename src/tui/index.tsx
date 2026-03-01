import React, { useState, useEffect } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { listTasks } from '../server/state/tasks.js'
import { listAgents } from '../server/state/agents.js'
import { workerLogPath } from '../spawner/index.js'
import type { Task } from '../server/state/tasks.js'
import type Database from 'better-sqlite3'

interface LatestLogRow {
  task_id: string
  message: string
  level: string
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

// Query the most recent log message per task in a single pass.
const LATEST_LOG_SQL = `
  SELECT task_id, message, level
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
  const { exit } = useApp()

  useEffect(() => {
    const refresh = () => {
      setTasks(listTasks(db))
      const rows = db.prepare(LATEST_LOG_SQL).all() as LatestLogRow[]
      setLatestLogs(new Map(rows.map(r => [r.task_id, r])))
    }
    refresh()
    const interval = setInterval(refresh, refreshMs)
    return () => clearInterval(interval)
  }, [db, refreshMs])

  useInput((input) => {
    if (input === 'q') exit()
  })

  // suppress unused import warning
  void listAgents

  const running = tasks.filter(t => t.status === 'in_progress').length
  const done = tasks.filter(t => t.status === 'done').length
  const failed = tasks.filter(t => t.status === 'failed').length

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>MultiClaude  </Text>
        <Text color="blue">■ {running} running  </Text>
        <Text color="green">✓ {done} done  </Text>
        {failed > 0 && <Text color="red">✗ {failed} failed  </Text>}
        <Text dimColor>[q]uit  [w] web logs</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>{'TASK'.padEnd(30)} {'STATUS'.padEnd(15)} AGENT</Text>
        {tasks.map(t => {
          const icon = STATUS_ICONS[t.status] ?? '?'
          const color = STATUS_COLORS[t.status] ?? 'white'
          const log = latestLogs.get(t.id)
          const logMsg = log?.message?.replace(/\n/g, ' ').slice(0, 55)
          return (
            <Box key={t.id} flexDirection="column">
              <Box>
                <Text color={color}>
                  {icon} {t.title.slice(0, 28).padEnd(29)}{' '}
                </Text>
                <Text color={color}>
                  {t.status.padEnd(14)}{' '}
                </Text>
                <Text dimColor>{t.agent_id ?? '-'}</Text>
                {t.retry_count > 0 && (
                  <Text color="yellow">  ⚠ retry {t.retry_count}/{t.max_retries}</Text>
                )}
              </Box>
              {t.status === 'in_progress' && t.agent_id && (
                <Box paddingLeft={3}>
                  {logMsg ? (
                    <Text dimColor>↳ {logMsg}</Text>
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
