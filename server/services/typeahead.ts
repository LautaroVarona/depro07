/**
 * Typeahead léxico inmediato (FTS5 + alias_norm). Sin Cohere.
 */
import { getDb } from '../db.js'
import { rows, row } from '../sql.js'
import { normalizeName } from './entityMatch.js'
import { normalizePersonKind } from './personKinds.js'
import { normalizeProjectKind } from './entityRelations.js'

export type TypeaheadKind = 'person' | 'project' | 'quantomo' | 'agrupacion'

export type TypeaheadHit = {
  kind: TypeaheadKind
  id: string
  label: string
  subtitle: string
  aliases: string[]
  score: number
}

export type TypeaheadOptions = {
  kinds?: TypeaheadKind[]
  limit?: number
  /** masters = perfiles/proyectos manuales; all = cualquier no-merged */
  scope?: 'masters' | 'all'
}

function escapeFtsToken(raw: string): string {
  return raw.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildFtsQuery(qNorm: string): string | null {
  const tokens = escapeFtsToken(qNorm)
    .split(' ')
    .map((t) => t.replace(/[^a-z0-9]/gi, ''))
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  // Prefijo en el último token para typeahead: lau*
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `${t}*` : t))
    .join(' ')
}

function bumpScore(map: Map<string, number>, id: string, score: number): void {
  const prev = map.get(id) ?? 0
  if (score > prev) map.set(id, score)
}

function scoreAliasMatch(qNorm: string, aliasNorm: string): number {
  if (!qNorm || !aliasNorm) return 0
  if (aliasNorm === qNorm) return 1
  if (aliasNorm.startsWith(qNorm)) return 0.92
  if (aliasNorm.includes(qNorm)) return 0.72
  return 0
}

function parseAliasesJson(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map((a) => String(a)).filter(Boolean)
  } catch {
    /* ignore */
  }
  return []
}

function searchPersons(
  qNorm: string,
  ftsQuery: string | null,
  scope: 'masters' | 'all',
  limit: number,
): TypeaheadHit[] {
  const db = getDb()
  const scores = new Map<string, number>()

  const masterClause =
    scope === 'masters'
      ? `AND p.source = 'manual'
         AND (p.status IS NULL OR p.status = 'active')
         AND p.kind IN ('fisica','juridica','ficticia','agrupacion')`
      : ''

  // Prefijo / substring vía índice alias_norm
  const aliasHits = rows<{ person_id: string; alias_norm: string }>(
    db
      .prepare(
        `SELECT a.person_id, a.alias_norm
         FROM entity_aliases a
         JOIN persons p ON p.id = a.person_id
         WHERE (p.merged_into IS NULL OR p.merged_into = '')
           ${masterClause}
           AND (a.alias_norm = ? OR a.alias_norm LIKE ? OR a.alias_norm LIKE ?)
         LIMIT 80`,
      )
      .all(qNorm, `${qNorm}%`, `%${qNorm}%`),
  )
  for (const h of aliasHits) {
    bumpScore(scores, h.person_id, scoreAliasMatch(qNorm, h.alias_norm))
  }

  if (ftsQuery) {
    try {
      const ftsHits = rows<{ person_id: string; rank: number }>(
        db
          .prepare(
            `SELECT f.person_id AS person_id, bm25(persons_fts) AS rank
             FROM persons_fts f
             JOIN persons p ON p.id = f.person_id
             WHERE persons_fts MATCH ?
               AND (p.merged_into IS NULL OR p.merged_into = '')
               ${masterClause}
             ORDER BY rank
             LIMIT 40`,
          )
          .all(ftsQuery),
      )
      for (const h of ftsHits) {
        // bm25: más negativo = mejor; map a 0.45–0.88
        const s = Math.min(0.88, Math.max(0.45, 0.88 + h.rank * 0.05))
        bumpScore(scores, h.person_id, s)
      }
    } catch (err) {
      console.warn('[typeahead] persons FTS:', err)
    }
  }

  const ids = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)

  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const people = rows<{
    id: string
    name: string
    kind: string
    aliases: string
  }>(
    db
      .prepare(
        `SELECT id, name, kind, aliases FROM persons WHERE id IN (${placeholders})`,
      )
      .all(...ids),
  )
  const byId = new Map(people.map((p) => [p.id, p]))

  return ids
    .map((id) => {
      const p = byId.get(id)
      if (!p) return null
      return {
        kind: 'person' as const,
        id: p.id,
        label: p.name,
        subtitle: normalizePersonKind(p.kind),
        aliases: parseAliasesJson(p.aliases),
        score: Math.round((scores.get(id) ?? 0) * 1000) / 1000,
      }
    })
    .filter((x): x is TypeaheadHit => x !== null)
}

function searchProjects(
  qNorm: string,
  ftsQuery: string | null,
  scope: 'masters' | 'all',
  limit: number,
): TypeaheadHit[] {
  const db = getDb()
  const scores = new Map<string, number>()
  const masterClause = scope === 'masters' ? `AND p.source = 'manual'` : ''

  const aliasHits = rows<{ project_id: string; alias_norm: string }>(
    db
      .prepare(
        `SELECT a.project_id, a.alias_norm
         FROM project_aliases a
         JOIN projects p ON p.id = a.project_id
         WHERE (p.merged_into IS NULL OR p.merged_into = '')
           ${masterClause}
           AND (a.alias_norm = ? OR a.alias_norm LIKE ? OR a.alias_norm LIKE ?)
         LIMIT 80`,
      )
      .all(qNorm, `${qNorm}%`, `%${qNorm}%`),
  )
  for (const h of aliasHits) {
    bumpScore(scores, h.project_id, scoreAliasMatch(qNorm, h.alias_norm))
  }

  if (ftsQuery) {
    try {
      const ftsHits = rows<{ project_id: string; rank: number }>(
        db
          .prepare(
            `SELECT f.project_id AS project_id, bm25(projects_fts) AS rank
             FROM projects_fts f
             JOIN projects p ON p.id = f.project_id
             WHERE projects_fts MATCH ?
               AND (p.merged_into IS NULL OR p.merged_into = '')
               ${masterClause}
             ORDER BY rank
             LIMIT 40`,
          )
          .all(ftsQuery),
      )
      for (const h of ftsHits) {
        const s = Math.min(0.88, Math.max(0.45, 0.88 + h.rank * 0.05))
        bumpScore(scores, h.project_id, s)
      }
    } catch (err) {
      console.warn('[typeahead] projects FTS:', err)
    }
  }

  const ids = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const projects = rows<{
    id: string
    title: string
    category: string | null
    aliases: string | null
  }>(
    db
      .prepare(
        `SELECT id, title, category, aliases FROM projects WHERE id IN (${placeholders})`,
      )
      .all(...ids),
  )
  const byId = new Map(projects.map((p) => [p.id, p]))

  return ids
    .map((id) => {
      const p = byId.get(id)
      if (!p) return null
      return {
        kind: 'project' as const,
        id: p.id,
        label: p.title,
        subtitle: normalizeProjectKind(p.category),
        aliases: parseAliasesJson(p.aliases),
        score: Math.round((scores.get(id) ?? 0) * 1000) / 1000,
      }
    })
    .filter((x): x is TypeaheadHit => x !== null)
}

function searchQuantomos(
  qNorm: string,
  ftsQuery: string | null,
  limit: number,
): TypeaheadHit[] {
  const db = getDb()
  const scores = new Map<string, number>()

  const likeHits = rows<{ id: string; title: string }>(
    db
      .prepare(
        `SELECT id, title FROM quantomos
         WHERE recognized = 1
           AND (title LIKE ? COLLATE NOCASE OR title LIKE ? COLLATE NOCASE)
         LIMIT 40`,
      )
      .all(`${qNorm}%`, `%${qNorm}%`),
  )
  for (const h of likeHits) {
    const tNorm = normalizeName(h.title)
    bumpScore(scores, h.id, scoreAliasMatch(qNorm, tNorm) || 0.65)
  }

  if (ftsQuery) {
    try {
      const ftsHits = rows<{ quantomo_id: string; rank: number }>(
        db
          .prepare(
            `SELECT f.quantomo_id AS quantomo_id, bm25(quantomos_fts) AS rank
             FROM quantomos_fts f
             JOIN quantomos q ON q.id = f.quantomo_id
             WHERE quantomos_fts MATCH ?
               AND q.recognized = 1
             ORDER BY rank
             LIMIT 40`,
          )
          .all(ftsQuery),
      )
      for (const h of ftsHits) {
        const s = Math.min(0.85, Math.max(0.4, 0.85 + h.rank * 0.05))
        bumpScore(scores, h.quantomo_id, s)
      }
    } catch (err) {
      console.warn('[typeahead] quantomos FTS:', err)
    }
  }

  const ids = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const quantomos = rows<{ id: string; title: string; universe: string | null }>(
    db
      .prepare(
        `SELECT id, title, universe FROM quantomos WHERE id IN (${placeholders})`,
      )
      .all(...ids),
  )
  const byId = new Map(quantomos.map((q) => [q.id, q]))

  return ids
    .map((id) => {
      const q = byId.get(id)
      if (!q) return null
      return {
        kind: 'quantomo' as const,
        id: q.id,
        label: q.title,
        subtitle: q.universe ?? 'quantomo',
        aliases: [] as string[],
        score: Math.round((scores.get(id) ?? 0) * 1000) / 1000,
      }
    })
    .filter((x): x is TypeaheadHit => x !== null)
}

function searchAgrupaciones(qNorm: string, limit: number): TypeaheadHit[] {
  const db = getDb()
  const all = rows<{
    id: string
    name: string
    member_count: number
  }>(
    db
      .prepare(
        `SELECT a.id, a.name,
                (SELECT COUNT(*) FROM agrupacion_members m
                 WHERE m.agrupacion_id = a.id) AS member_count
         FROM agrupaciones a`,
      )
      .all(),
  )

  const scored: TypeaheadHit[] = []
  for (const h of all) {
    const tNorm = normalizeName(h.name)
    const score = scoreAliasMatch(qNorm, tNorm)
    if (score <= 0) continue
    const n = Number(h.member_count) || 0
    scored.push({
      kind: 'agrupacion',
      id: h.id,
      label: h.name,
      subtitle: n === 1 ? '1 miembro' : `${n} miembros`,
      aliases: [],
      score: Math.round(score * 1000) / 1000,
    })
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(limit, 8))
}

export function typeaheadEntities(
  query: string,
  opts?: TypeaheadOptions,
): TypeaheadHit[] {
  const q = query.trim()
  if (!q) return []

  const kinds = opts?.kinds?.length
    ? opts.kinds
    : (['person', 'project'] as TypeaheadKind[])
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 40)
  const scope = opts?.scope ?? 'masters'
  const qNorm = normalizeName(q)
  if (!qNorm) return []
  const ftsQuery = buildFtsQuery(qNorm)

  const perKind = Math.max(limit, 8)
  const hits: TypeaheadHit[] = []

  if (kinds.includes('person')) {
    hits.push(...searchPersons(qNorm, ftsQuery, scope, perKind))
  }
  if (kinds.includes('project')) {
    hits.push(...searchProjects(qNorm, ftsQuery, scope, perKind))
  }
  if (kinds.includes('quantomo')) {
    hits.push(...searchQuantomos(qNorm, ftsQuery, perKind))
  }
  if (kinds.includes('agrupacion')) {
    hits.push(...searchAgrupaciones(qNorm, perKind))
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

export function listRecentEntities(
  kinds: TypeaheadKind[],
  limit = 10,
): TypeaheadHit[] {
  const db = getDb()
  const cap = Math.min(Math.max(limit, 1), 20)
  const hits: TypeaheadHit[] = []

  if (kinds.includes('person')) {
    const people = rows<{
      id: string
      name: string
      kind: string
      aliases: string
    }>(
      db
        .prepare(
          `SELECT id, name, kind, aliases FROM persons
           WHERE (merged_into IS NULL OR merged_into = '')
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(cap),
    )
    for (const p of people) {
      hits.push({
        kind: 'person',
        id: p.id,
        label: p.name,
        subtitle: normalizePersonKind(p.kind),
        aliases: parseAliasesJson(p.aliases),
        score: 0.5,
      })
    }
  }

  if (kinds.includes('agrupacion')) {
    const groups = rows<{ id: string; name: string; member_count: number }>(
      db
        .prepare(
          `SELECT a.id, a.name,
                  (SELECT COUNT(*) FROM agrupacion_members m
                   WHERE m.agrupacion_id = a.id) AS member_count
           FROM agrupaciones a
           ORDER BY a.updated_at DESC
           LIMIT ?`,
        )
        .all(cap),
    )
    for (const g of groups) {
      const n = Number(g.member_count) || 0
      hits.push({
        kind: 'agrupacion',
        id: g.id,
        label: g.name,
        subtitle: n === 1 ? '1 miembro' : `${n} miembros`,
        aliases: [],
        score: 0.48,
      })
    }
  }

  if (kinds.includes('project')) {
    const projects = rows<{
      id: string
      title: string
      category: string | null
      aliases: string | null
    }>(
      db
        .prepare(
          `SELECT id, title, category, aliases FROM projects
           WHERE (merged_into IS NULL OR merged_into = '')
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(cap),
    )
    for (const p of projects) {
      hits.push({
        kind: 'project',
        id: p.id,
        label: p.title,
        subtitle: normalizeProjectKind(p.category),
        aliases: parseAliasesJson(p.aliases),
        score: 0.45,
      })
    }
  }

  return hits.slice(0, cap)
}

/** Hidrata un hit suelto (útil para tests / debug). */
export function getTypeaheadLabel(
  kind: TypeaheadKind,
  id: string,
): string | null {
  const db = getDb()
  if (kind === 'person') {
    return (
      row<{ name: string }>(
        db.prepare(`SELECT name FROM persons WHERE id = ?`).get(id),
      )?.name ?? null
    )
  }
  if (kind === 'project') {
    return (
      row<{ title: string }>(
        db.prepare(`SELECT title FROM projects WHERE id = ?`).get(id),
      )?.title ?? null
    )
  }
  if (kind === 'agrupacion') {
    return (
      row<{ name: string }>(
        db.prepare(`SELECT name FROM agrupaciones WHERE id = ?`).get(id),
      )?.name ?? null
    )
  }
  return (
    row<{ title: string }>(
      db.prepare(`SELECT title FROM quantomos WHERE id = ?`).get(id),
    )?.title ?? null
  )
}
