import type Database from 'better-sqlite3'

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'cancelled'

export interface Task {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  retry_count: number
  max_retries: number
  worktree_path: string | null
  branch: string | null
  agent_id: string | null
  created_at: string
  updated_at: string
}

export interface CreateTaskInput {
  id: string
  title: string
  description?: string
  max_retries?: number
}

export interface UpdateTaskInput {
  status?: TaskStatus
  retry_count?: number
  worktree_path?: string
  branch?: string
  agent_id?: string
}

export function createTask(db: Database.Database, input: CreateTaskInput): void {
  db.prepare(`
    INSERT INTO tasks (id, title, description, max_retries)
    VALUES (@id, @title, @description, @max_retries)
  `).run({
    id: input.id,
    title: input.title,
    description: input.description ?? null,
    max_retries: input.max_retries ?? 3,
  })
}

export function getTask(db: Database.Database, id: string): Task | null {
  return (db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined) ?? null
}

export function updateTask(db: Database.Database, id: string, input: UpdateTaskInput): void {
  const sets: string[] = ["updated_at = datetime('now')"]
  const params: Record<string, unknown> = { id }

  if (input.status !== undefined) { sets.push('status = @status'); params.status = input.status }
  if (input.retry_count !== undefined) { sets.push('retry_count = @retry_count'); params.retry_count = input.retry_count }
  if (input.worktree_path !== undefined) { sets.push('worktree_path = @worktree_path'); params.worktree_path = input.worktree_path }
  if (input.branch !== undefined) { sets.push('branch = @branch'); params.branch = input.branch }
  if (input.agent_id !== undefined) { sets.push('agent_id = @agent_id'); params.agent_id = input.agent_id }

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params as any)
}

export function listTasks(db: Database.Database, status?: TaskStatus): Task[] {
  if (status) {
    return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at').all(status) as Task[]
  }
  return db.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Task[]
}
