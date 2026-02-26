import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask, getTask, updateTask, listTasks } from '../../src/server/state/tasks.js'
import type Database from 'better-sqlite3'

describe('tasks', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('creates a task and retrieves it by id', () => {
    createTask(db, { id: 'task-1', title: 'Build auth', description: 'JWT impl' })
    const task = getTask(db, 'task-1')
    expect(task?.id).toBe('task-1')
    expect(task?.title).toBe('Build auth')
    expect(task?.status).toBe('pending')
  })

  it('updates task status', () => {
    createTask(db, { id: 'task-1', title: 'Build auth' })
    updateTask(db, 'task-1', { status: 'in_progress' })
    expect(getTask(db, 'task-1')?.status).toBe('in_progress')
  })

  it('increments retry count', () => {
    createTask(db, { id: 'task-1', title: 'Build auth' })
    updateTask(db, 'task-1', { retry_count: 1 })
    expect(getTask(db, 'task-1')?.retry_count).toBe(1)
  })

  it('lists tasks by status', () => {
    createTask(db, { id: 'task-1', title: 'A' })
    createTask(db, { id: 'task-2', title: 'B' })
    updateTask(db, 'task-2', { status: 'in_progress' })
    const pending = listTasks(db, 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('task-1')
  })

  it('returns null for missing task', () => {
    expect(getTask(db, 'nonexistent')).toBeNull()
  })
})
