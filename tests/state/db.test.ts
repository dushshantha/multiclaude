import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import type Database from 'better-sqlite3'

describe('db', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
  })

  afterEach(() => {
    closeDb(db)
  })

  it('creates all required tables', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain('tasks')
    expect(names).toContain('dag_edges')
    expect(names).toContain('agents')
    expect(names).toContain('logs')
  })

  it('tasks table has required columns', () => {
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
    const names = cols.map(c => c.name)
    expect(names).toContain('id')
    expect(names).toContain('title')
    expect(names).toContain('status')
    expect(names).toContain('retry_count')
    expect(names).toContain('worktree_path')
    expect(names).toContain('branch')
    expect(names).toContain('created_at')
    expect(names).toContain('updated_at')
  })
})
