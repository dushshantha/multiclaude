import { eq, and } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { developers } from '../db/schema.js'

export type Developer = typeof developers.$inferSelect

export async function createDeveloper(db: Db, input: {
  orgId: string
  email: string
  name?: string
}): Promise<Developer> {
  const [developer] = await db.insert(developers).values({
    orgId: input.orgId,
    email: input.email,
    name: input.name,
  }).returning()
  return developer
}

export async function getDeveloperByEmail(db: Db, orgId: string, email: string): Promise<Developer | null> {
  const rows = await db.select().from(developers).where(
    and(eq(developers.orgId, orgId), eq(developers.email, email))
  )
  return rows[0] ?? null
}

/**
 * Finds an existing developer by email within an org, or creates one if not found.
 * This is the preferred way to identify developers — pass an email, get back a stable ID.
 */
export async function upsertDeveloper(db: Db, orgId: string, email: string, name?: string): Promise<Developer> {
  const existing = await getDeveloperByEmail(db, orgId, email)
  if (existing) {
    return existing
  }
  return createDeveloper(db, { orgId, email, name })
}
