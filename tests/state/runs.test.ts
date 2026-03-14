import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { upsertProject } from '../../src/server/state/projects.js'
import { createRun, getRun, listRuns } from '../../src/server/state/runs.js'
import type Database from 'better-sqlite3'

describe('runs', () => {
  let db: Database.Database
  let projectId: string

  beforeEach(() => {
    db = createDb(':memory:')
    const p = upsertProject(db, { name: 'Test Project', cwd: '/tmp/test' })
    projectId = p.id
  })
  afterEach(() => { closeDb(db) })

  it('creates a run and retrieves it by id', () => {
    const run = createRun(db, { project_id: projectId, title: 'Sprint 1' })
    expect(run.id).toBeTruthy()
    expect(run.project_id).toBe(projectId)
    expect(run.title).toBe('Sprint 1')
    expect(run.status).toBe('open')
    expect(run.external_ref).toBeNull()
  })

  it('creates a run with external_ref', () => {
    const run = createRun(db, { project_id: projectId, title: 'PR #42', external_ref: 'github:pr:42' })
    expect(run.external_ref).toBe('github:pr:42')
  })

  it('getRun returns null for missing id', () => {
    expect(getRun(db, 'nonexistent')).toBeNull()
  })

  it('getRun returns the run by id', () => {
    const run = createRun(db, { project_id: projectId, title: 'Run A' })
    expect(getRun(db, run.id)?.title).toBe('Run A')
  })

  it('listRuns returns all runs when no project_id filter', () => {
    const p2 = upsertProject(db, { name: 'Other', cwd: '/tmp/other' })
    createRun(db, { project_id: projectId, title: 'Run 1' })
    createRun(db, { project_id: p2.id, title: 'Run 2' })
    expect(listRuns(db)).toHaveLength(2)
  })

  it('listRuns filters by project_id', () => {
    const p2 = upsertProject(db, { name: 'Other', cwd: '/tmp/other' })
    createRun(db, { project_id: projectId, title: 'Run 1' })
    createRun(db, { project_id: p2.id, title: 'Run 2' })
    const runs = listRuns(db, projectId)
    expect(runs).toHaveLength(1)
    expect(runs[0].title).toBe('Run 1')
  })

  it('listRuns returns empty array when no runs', () => {
    expect(listRuns(db)).toHaveLength(0)
  })
})
