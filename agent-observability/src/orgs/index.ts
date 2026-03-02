import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { orgs } from '../db/schema.js'

export interface CreateOrgInput {
  slug: string
  name: string
}

export type Org = typeof orgs.$inferSelect

export async function createOrg(db: Db, input: CreateOrgInput): Promise<Org> {
  const [org] = await db.insert(orgs).values(input).returning()
  return org
}

export async function getOrgBySlug(db: Db, slug: string): Promise<Org | null> {
  const rows = await db.select().from(orgs).where(eq(orgs.slug, slug))
  return rows[0] ?? null
}
