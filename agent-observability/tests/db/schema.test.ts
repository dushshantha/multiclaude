import { describe, it, expect } from 'vitest'
import { orgs, developers, sessions, outcomes, wasteSessions } from '../../src/db/schema.js'

describe('schema', () => {
  it('exports orgs table', () => expect(orgs).toBeDefined())
  it('exports developers table', () => expect(developers).toBeDefined())
  it('exports sessions table', () => expect(sessions).toBeDefined())
  it('exports outcomes table', () => expect(outcomes).toBeDefined())
  it('exports wasteSessions table', () => expect(wasteSessions).toBeDefined())
})
