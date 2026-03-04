import type { Db } from '../db/index.js'
import { sessions } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export async function createSession(db: Db, input: {
  orgId: string
  developerId?: string
  gitBranch?: string
  gitRepo?: string
  workingDir?: string
  taskDescription?: string
}) {
  const [session] = await db.insert(sessions).values({
    orgId: input.orgId,
    developerId: input.developerId,
    gitBranch: input.gitBranch,
    gitRepo: input.gitRepo,
    workingDir: input.workingDir,
    taskDescription: input.taskDescription,
    agentType: 'claude-code',
  }).returning()
  return session
}

export async function updateSession(db: Db, sessionId: string, updates: {
  tokensIn?: number
  tokensOut?: number
  costUsd?: string
  endedAt?: Date
  durationSecs?: number
}) {
  const [session] = await db.update(sessions)
    .set(updates)
    .where(eq(sessions.id, sessionId))
    .returning()
  return session
}

export async function getSession(db: Db, sessionId: string) {
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) })
  return session ?? null
}

export async function listSessions(db: Db, orgId: string) {
  return db.query.sessions.findMany({ where: eq(sessions.orgId, orgId) })
}
