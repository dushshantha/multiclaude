import React, { useState, useEffect } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { listTasks } from '../server/state/tasks.js'
import { listAgents } from '../server/state/agents.js'
import type { Task } from '../server/state/tasks.js'
import type { Agent } from '../server/state/agents.js'
import type Database from 'better-sqlite3'

interface LogRow {
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

interface DashboardProps {
  db: Database.Database
  refreshMs?: number
}

function Dashboard({ db, refreshMs = 1000 }: DashboardProps) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const { exit } = useApp()

  useEffect(() => {
    const refresh = () => {
      setTasks(listTasks(db))
      setAgents(listAgents(db))
      const recent = db.prepare('SELECT message, level FROM logs ORDER BY id DESC LIMIT 5').all() as LogRow[]
      setLogs(recent.reverse().map(l => `[${l.level}] ${l.message}`))
    }
    refresh()
    const interval = setInterval(refresh, refreshMs)
    return () => clearInterval(interval)
  }, [db, refreshMs])

  useInput((input) => {
    if (input === 'q') exit()
  })

  const running = tasks.filter(t => t.status === 'in_progress').length
  const done = tasks.filter(t => t.status === 'done').length
  const failed = tasks.filter(t => t.status === 'failed').length

  // suppress unused variable warning — agents are fetched for future use
  void agents

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>MultiClaude  </Text>
        <Text color="blue">■ {running} running  </Text>
        <Text color="green">✓ {done} done  </Text>
        {failed > 0 && <Text color="red">✗ {failed} failed  </Text>}
        <Text dimColor>[q]uit</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold dimColor>{'TASK'.padEnd(30)} {'STATUS'.padEnd(15)} BRANCH</Text>
        {tasks.map(t => {
          const icon = STATUS_ICONS[t.status] ?? '?'
          const color = STATUS_COLORS[t.status] ?? 'white'
          return (
            <Box key={t.id}>
              <Text color={color}>
                {icon} {t.title.slice(0, 28).padEnd(29)}{' '}
              </Text>
              <Text color={color}>
                {t.status.padEnd(14)}{' '}
              </Text>
              <Text dimColor>{t.branch ?? '-'}</Text>
              {t.retry_count > 0 && (
                <Text color="yellow">  ⚠ retry {t.retry_count}/{t.max_retries}</Text>
              )}
            </Box>
          )
        })}
      </Box>

      {logs.length > 0 && (
        <Box flexDirection="column" borderStyle="single" padding={1}>
          <Text bold dimColor>Recent Logs</Text>
          {logs.map((l, i) => (
            <Text key={i} dimColor>{l}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export function startTui(db: Database.Database): void {
  render(<Dashboard db={db} />)
}
