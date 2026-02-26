import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { registerAgent, getAgent, updateAgent, listAgents } from '../../src/server/state/agents.js'
import type Database from 'better-sqlite3'

describe('agents', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('registers and retrieves an agent', () => {
    registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 12345 })
    const agent = getAgent(db, 'w-1')
    expect(agent?.id).toBe('w-1')
    expect(agent?.task_id).toBe('task-1')
    expect(agent?.pid).toBe(12345)
    expect(agent?.status).toBe('spawning')
  })

  it('updates agent status', () => {
    registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 12345 })
    updateAgent(db, 'w-1', { status: 'running' })
    expect(getAgent(db, 'w-1')?.status).toBe('running')
  })

  it('lists agents by status', () => {
    registerAgent(db, { id: 'w-1', task_id: 'task-1', pid: 1 })
    registerAgent(db, { id: 'w-2', task_id: 'task-2', pid: 2 })
    updateAgent(db, 'w-1', { status: 'running' })
    expect(listAgents(db, 'running')).toHaveLength(1)
    expect(listAgents(db, 'spawning')).toHaveLength(1)
  })

  it('returns null for missing agent', () => {
    expect(getAgent(db, 'nonexistent')).toBeNull()
  })
})
