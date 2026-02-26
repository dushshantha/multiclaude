import type Database from 'better-sqlite3'

export type AgentStatus = 'spawning' | 'running' | 'done' | 'failed'

export interface Agent {
  id: string
  task_id: string | null
  pid: number | null
  status: AgentStatus
  created_at: string
}

export function registerAgent(db: Database.Database, input: { id: string; task_id?: string; pid?: number }): void {
  db.prepare('INSERT INTO agents (id, task_id, pid) VALUES (@id, @task_id, @pid)').run({
    id: input.id,
    task_id: input.task_id ?? null,
    pid: input.pid ?? null,
  })
}

export function getAgent(db: Database.Database, id: string): Agent | null {
  return (db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined) ?? null
}

export function updateAgent(db: Database.Database, id: string, input: { status?: AgentStatus; pid?: number }): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status }
  if (input.pid !== undefined) { sets.push('pid = @pid'); params.pid = input.pid }
  if (sets.length === 0) return
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

export function listAgents(db: Database.Database, status?: AgentStatus): Agent[] {
  if (status) {
    return db.prepare('SELECT * FROM agents WHERE status = ?').all(status) as Agent[]
  }
  return db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Agent[]
}
