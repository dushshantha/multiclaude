import type { Db } from '../db/index.js'
import { wasteSessions, sessions, outcomes } from '../db/schema.js'
import { eq } from 'drizzle-orm'

const WASTE_THRESHOLD_MS = 48 * 60 * 60 * 1000

export async function detectWaste(db: Db): Promise<number> {
  const allSessions = await db.query.sessions.findMany()
  let flagged = 0

  for (const session of allSessions) {
    const ageMs = Date.now() - session.startedAt.getTime()
    if (ageMs < WASTE_THRESHOLD_MS) continue

    const outcome = await db.query.outcomes.findFirst({ where: eq(outcomes.sessionId, session.id) })
    if (outcome) continue

    const alreadyFlagged = await db.query.wasteSessions.findFirst({ where: eq(wasteSessions.sessionId, session.id) })
    if (alreadyFlagged) continue

    await db.insert(wasteSessions).values({
      sessionId: session.id,
      orgId: session.orgId,
      reason: 'no_outcome_48h',
      costUsd: session.costUsd,
    })

    flagged++
  }

  return flagged
}
