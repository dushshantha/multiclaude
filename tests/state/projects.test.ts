import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDb, closeDb } from '../../src/server/state/db.js'
import { upsertProject, getProject, listProjects } from '../../src/server/state/projects.js'
import { createRun } from '../../src/server/state/runs.js'
import { createTask, updateTask } from '../../src/server/state/tasks.js'
import type Database from 'better-sqlite3'

describe('projects', () => {
  let db: Database.Database

  beforeEach(() => { db = createDb(':memory:') })
  afterEach(() => { closeDb(db) })

  it('creates a new project when cwd is not found', () => {
    const p = upsertProject(db, { name: 'My Project', cwd: '/home/user/myproject' })
    expect(p.id).toBeTruthy()
    expect(p.name).toBe('My Project')
    expect(p.cwd).toBe('/home/user/myproject')
  })

  it('upserts an existing project by cwd, updating name and last_active_at', () => {
    const p1 = upsertProject(db, { name: 'Old Name', cwd: '/home/user/proj' })
    const p2 = upsertProject(db, { name: 'New Name', cwd: '/home/user/proj' })
    expect(p2.id).toBe(p1.id)
    expect(p2.name).toBe('New Name')
  })

  it('returns null for a missing project id', () => {
    expect(getProject(db, 'nonexistent')).toBeNull()
  })

  it('getProject returns project by id', () => {
    const p = upsertProject(db, { name: 'Test', cwd: '/tmp/test' })
    expect(getProject(db, p.id)?.cwd).toBe('/tmp/test')
  })

  it('listProjects returns aggregate stats', () => {
    const p = upsertProject(db, { name: 'Stats Project', cwd: '/tmp/stats' })
    const run = createRun(db, { project_id: p.id, title: 'Run 1' })
    createTask(db, { id: 't1', title: 'Task 1' })
    createTask(db, { id: 't2', title: 'Task 2' })
    // Link tasks to run via run_id
    db.prepare("UPDATE tasks SET run_id = ? WHERE id IN ('t1','t2')").run(run.id)
    updateTask(db, 't1', { status: 'done' })
    updateTask(db, 't2', { status: 'failed' })

    const projects = listProjects(db)
    expect(projects).toHaveLength(1)
    const stats = projects[0]
    expect(stats.total_runs).toBe(1)
    expect(stats.total_tasks).toBe(2)
    expect(stats.done_tasks).toBe(1)
    expect(stats.failed_tasks).toBe(1)
  })

  it('listProjects returns empty array when no projects', () => {
    expect(listProjects(db)).toHaveLength(0)
  })
})
