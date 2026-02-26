import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { createTask } from '../../src/server/state/tasks.js'
import { addEdge, getBlockers, getReadyTasks, getDependents } from '../../src/server/state/dag.js'
import type Database from 'better-sqlite3'

describe('dag', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createDb(':memory:')
    // Build graph: a → b, a → c, b → d, c → d
    createTask(db, { id: 'a', title: 'API Contract' })
    createTask(db, { id: 'b', title: 'JWT Impl' })
    createTask(db, { id: 'c', title: 'OAuth Impl' })
    createTask(db, { id: 'd', title: 'Tests' })
    addEdge(db, 'a', 'b')
    addEdge(db, 'a', 'c')
    addEdge(db, 'b', 'd')
    addEdge(db, 'c', 'd')
  })

  afterEach(() => { closeDb(db) })

  it('getBlockers returns upstream dependencies', () => {
    expect(getBlockers(db, 'b')).toEqual(['a'])
    const dBlockers = getBlockers(db, 'd')
    expect(dBlockers).toContain('b')
    expect(dBlockers).toContain('c')
  })

  it('getReadyTasks returns only tasks with all blockers done', () => {
    // Initially only 'a' is ready (no blockers, pending)
    const ready = getReadyTasks(db)
    expect(ready.map(t => t.id)).toEqual(['a'])
  })

  it('getReadyTasks unblocks b and c when a is done', () => {
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'a'").run()
    const ready = getReadyTasks(db)
    const ids = ready.map(t => t.id)
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(ids).not.toContain('d')
  })

  it('getDependents returns downstream tasks', () => {
    const deps = getDependents(db, 'a')
    expect(deps).toContain('b')
    expect(deps).toContain('c')
  })
})
