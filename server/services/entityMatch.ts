/**
 * Matching de menciones NER → perfiles maestros (exacto + fuzzy).
 * Exacto / fuzzy fuerte → propuesta link; fuzzy medio → create + suggested_match.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  EntryEntityRaw,
  EntityKind,
  EntityProposal,
  Person,
  Project,
} from '../types.js'
import { rows, row } from '../sql.js'
import {
  isProfileKind,
  normalizePersonKind,
  type PersonKind,
} from './personKinds.js'

export function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseAliases(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed.map((a) => String(a)).filter(Boolean)
    }
  } catch {
    /* ignore */
  }
  return []
}

function entityKeys(name: string, aliasesJson?: string | null): string[] {
  const keys = new Set<string>()
  const n = normalizeName(name)
  if (n) keys.add(n)
  for (const a of parseAliases(aliasesJson)) {
    const k = normalizeName(a)
    if (k) keys.add(k)
  }
  return [...keys]
}

/** Dice coefficient sobre bigramas; 1 = idéntico. */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.length < 2 || b.length < 2) {
    return a === b ? 1 : 0
  }
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2)
      m.set(bg, (m.get(bg) ?? 0) + 1)
    }
    return m
  }
  const A = bigrams(a)
  const B = bigrams(b)
  let overlap = 0
  for (const [bg, c] of A) {
    const o = B.get(bg)
    if (o) overlap += Math.min(c, o)
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1))
}

const FUZZY_LINK = 0.86
const FUZZY_SUGGEST = 0.68

export type PersonMatch = {
  person: Person
  score: number
  mode: 'exact' | 'fuzzy'
}

export function findBestPersonMatch(
  mention: string,
  persons: Person[],
): PersonMatch | null {
  const norm = normalizeName(mention)
  if (!norm) return null

  let best: PersonMatch | null = null

  for (const p of persons) {
    // Solo perfiles reales (no ruido/abstracta que hayan quedado)
    if (!isProfileKind(normalizePersonKind(p.kind))) continue

    for (const key of entityKeys(p.name, p.aliases)) {
      if (key === norm) {
        return { person: p, score: 1, mode: 'exact' }
      }
      const score = stringSimilarity(norm, key)
      if (!best || score > best.score) {
        best = { person: p, score, mode: 'fuzzy' }
      }
      // Prefijo / contención (Cami ⊂ Camila)
      if (
        (key.startsWith(norm) || norm.startsWith(key)) &&
        Math.min(key.length, norm.length) >= 3
      ) {
        const containScore =
          Math.min(key.length, norm.length) /
          Math.max(key.length, norm.length)
        const boosted = Math.max(containScore, 0.75)
        if (!best || boosted > best.score) {
          best = { person: p, score: boosted, mode: 'fuzzy' }
        }
      }

      // Apodo = primer token del perfil (Cami → Camila Verdún)
      const first = key.split(' ')[0] ?? ''
      if (first.length >= 3 && norm.length >= 3) {
        if (first === norm) {
          const nickScore = 0.93
          if (!best || nickScore > best.score) {
            best = { person: p, score: nickScore, mode: 'fuzzy' }
          }
        } else if (first.startsWith(norm) || norm.startsWith(first)) {
          const nickScore = Math.max(
            0.82,
            Math.min(first.length, norm.length) /
              Math.max(first.length, norm.length),
          )
          if (!best || nickScore > best.score) {
            best = { person: p, score: nickScore, mode: 'fuzzy' }
          }
        } else {
          const tokenSim = stringSimilarity(norm, first)
          if (tokenSim >= 0.8 && (!best || tokenSim > best.score)) {
            best = { person: p, score: tokenSim, mode: 'fuzzy' }
          }
        }
      }
    }
  }

  if (!best || best.score < FUZZY_SUGGEST) return null
  return best
}

export type ProjectMatch = {
  project: Project
  score: number
  mode: 'exact' | 'fuzzy'
}

export function findBestProjectMatch(
  mention: string,
  projects: Project[],
): ProjectMatch | null {
  const norm = normalizeName(mention)
  if (!norm) return null

  let best: ProjectMatch | null = null

  for (const p of projects) {
    // Solo maestros (manual) para link fuerte; si no hay source, incluir
    if (p.source && p.source !== 'manual') continue
    if (p.merged_into) continue

    for (const key of entityKeys(p.title, p.aliases)) {
      if (key === norm) {
        return { project: p, score: 1, mode: 'exact' }
      }
      const score = stringSimilarity(norm, key)
      if (!best || score > best.score) {
        best = { project: p, score, mode: 'fuzzy' }
      }
      if (
        (key.startsWith(norm) || norm.startsWith(key)) &&
        Math.min(key.length, norm.length) >= 3
      ) {
        const containScore =
          Math.min(key.length, norm.length) /
          Math.max(key.length, norm.length)
        const boosted = Math.max(containScore, 0.75)
        if (!best || boosted > best.score) {
          best = { project: p, score: boosted, mode: 'fuzzy' }
        }
      }

      const first = key.split(' ')[0] ?? ''
      if (first.length >= 3 && norm.length >= 3) {
        if (first === norm) {
          const nickScore = 0.93
          if (!best || nickScore > best.score) {
            best = { project: p, score: nickScore, mode: 'fuzzy' }
          }
        } else if (first.startsWith(norm) || norm.startsWith(first)) {
          const nickScore = Math.max(
            0.82,
            Math.min(first.length, norm.length) /
              Math.max(first.length, norm.length),
          )
          if (!best || nickScore > best.score) {
            best = { project: p, score: nickScore, mode: 'fuzzy' }
          }
        }
      }
    }
  }

  if (!best || best.score < FUZZY_SUGGEST) return null
  return best
}

function mapRawType(type: string): EntityKind | null {
  const t = type.toLowerCase().trim()
  if (
    t === 'person' ||
    t === 'persona' ||
    t === 'people' ||
    t === 'fisica' ||
    t === 'juridica' ||
    t === 'agrupacion' ||
    t === 'ficticia' ||
    t === 'ficticio' ||
    t === 'abstracta' ||
    t === 'ruido' ||
    t === 'organización' ||
    t === 'organizacion'
  ) {
    return 'person'
  }
  if (
    t === 'project' ||
    t === 'proyecto' ||
    t === 'initiative' ||
    t === 'iniciativa' ||
    t === 'tarea' ||
    t === 'reto' ||
    t === 'concepto'
  ) {
    return 'project'
  }
  return null
}

function buildEvidence(
  entryId: string,
  name: string,
  transcript: string | null,
): string {
  const text = (transcript ?? '').replace(/\s+/g, ' ').trim()
  const idx = text.toLowerCase().indexOf(name.toLowerCase())
  let snippet = ''
  if (idx >= 0) {
    const start = Math.max(0, idx - 60)
    const end = Math.min(text.length, idx + name.length + 80)
    snippet = text.slice(start, end).trim()
  } else {
    snippet = text.slice(0, 160)
  }
  return JSON.stringify({
    entry_id: entryId,
    mention: name,
    snippet,
  })
}

/**
 * Tras aprobar Aduana de entry: convierte entities raw en propuestas create/link.
 */
export function createEntityProposalsFromEntry(
  db: DatabaseSync,
  entryId: string,
): EntityProposal[] {
  const entry = row<{ content_raw: string | null }>(
    db.prepare(`SELECT content_raw FROM entries WHERE id = ?`).get(entryId),
  )
  if (!entry) return []

  const rawRows = rows<EntryEntityRaw>(
    db.prepare(`SELECT * FROM entry_entities_raw WHERE entry_id = ?`).all(entryId),
  )

  const persons = rows<Person>(
    db
      .prepare(
        `SELECT * FROM persons
         WHERE source = 'manual'
           AND (merged_into IS NULL OR merged_into = '')`,
      )
      .all(),
  )
  const projects = rows<Project>(
    db
      .prepare(
        `SELECT * FROM projects
         WHERE source = 'manual'
           AND (merged_into IS NULL OR merged_into = '')`,
      )
      .all(),
  )

  const existing = rows<{ suggested_name: string; kind: string }>(
    db
      .prepare(
        `SELECT suggested_name, kind FROM entity_proposals
         WHERE entry_id = ? AND status = 'pending'`,
      )
      .all(entryId),
  )
  const pendingKeys = new Set(
    existing.map((e) => `${e.kind}::${normalizeName(e.suggested_name)}`),
  )

  const insert = db.prepare(`
    INSERT INTO entity_proposals (
      id, entry_id, kind, proposal_type, suggested_name,
      suggested_meta, matched_entity_id, evidence, status, created_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
  `)

  const created: EntityProposal[] = []
  const now = new Date().toISOString()
  const seen = new Set<string>()

  for (const raw of rawRows) {
    const kind = mapRawType(raw.type)
    if (!kind) continue

    const name = raw.name.trim()
    if (!name) continue

    const norm = normalizeName(name)
    if (!norm) continue

    const dedupeKey = `${kind}::${norm}`
    if (seen.has(dedupeKey) || pendingKeys.has(dedupeKey)) continue
    seen.add(dedupeKey)

    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(raw.payload || '{}') as Record<string, unknown>
    } catch {
      payload = {}
    }

    let proposalType: 'create' | 'link' = 'create'
    let matchedId: string | null = null
    let meta: Record<string, unknown> = { ...payload }

    if (kind === 'person') {
      const personKind: PersonKind = normalizePersonKind(
        typeof payload.kind === 'string' ? payload.kind : raw.type,
      )
      meta = { ...meta, kind: personKind }

      // Ruido/abstracta: no intentamos match; el validador las descarta fácil
      if (personKind === 'ruido' || personKind === 'abstracta') {
        meta = {
          ...meta,
          match_mode: 'none',
          discard_hint: personKind,
        }
      } else {
        const match = findBestPersonMatch(name, persons)
        if (match && (match.mode === 'exact' || match.score >= FUZZY_LINK)) {
          proposalType = 'link'
          matchedId = match.person.id
          meta = {
            ...meta,
            matched_name: match.person.name,
            kind: normalizePersonKind(match.person.kind),
            match_score: match.score,
            match_mode: match.mode,
          }
        } else if (match && match.score >= FUZZY_SUGGEST) {
          meta = {
            ...meta,
            suggested_match_id: match.person.id,
            suggested_match_name: match.person.name,
            match_score: match.score,
            match_mode: 'fuzzy',
          }
        }
      }
    } else {
      const match = findBestProjectMatch(name, projects)
      if (match && (match.mode === 'exact' || match.score >= FUZZY_LINK)) {
        proposalType = 'link'
        matchedId = match.project.id
        meta = {
          ...meta,
          matched_title: match.project.title,
          category: match.project.category,
          status: match.project.status,
          match_score: match.score,
          match_mode: match.mode,
        }
      } else {
        meta = {
          ...meta,
          category:
            typeof payload.category === 'string'
              ? payload.category
              : raw.type.toLowerCase().includes('tarea') ||
                  raw.type.toLowerCase().includes('reto')
                ? 'tarea'
                : raw.type.toLowerCase().includes('concepto')
                  ? 'concepto'
                  : 'proyecto',
          status:
            typeof payload.status === 'string' ? payload.status : 'emergente',
          tactical_focus:
            typeof payload.tactical_focus === 'string'
              ? payload.tactical_focus
              : null,
        }
        if (match && match.score >= FUZZY_SUGGEST) {
          meta = {
            ...meta,
            suggested_match_id: match.project.id,
            suggested_match_name: match.project.title,
            match_score: match.score,
            match_mode: 'fuzzy',
          }
        }
      }
    }

    const id = randomUUID()
    const evidence = buildEvidence(entryId, name, entry.content_raw)
    const suggestedMeta = JSON.stringify(meta)

    insert.run(
      id,
      entryId,
      kind,
      proposalType,
      name,
      suggestedMeta,
      matchedId,
      evidence,
      now,
    )

    created.push({
      id,
      entry_id: entryId,
      kind,
      proposal_type: proposalType,
      suggested_name: name,
      suggested_meta: suggestedMeta,
      matched_entity_id: matchedId,
      evidence,
      status: 'pending',
      created_at: now,
      resolved_at: null,
    })
  }

  return created
}

/** Recomputa sugerencia fuzzy en vivo (para propuestas create pendientes). */
export function liveSuggestedMatch(
  mention: string,
  persons: Person[],
): { id: string; name: string; score: number } | null {
  const match = findBestPersonMatch(mention, persons)
  if (!match || match.score < FUZZY_SUGGEST) return null
  return {
    id: match.person.id,
    name: match.person.name,
    score: Math.round(match.score * 100) / 100,
  }
}

export function liveSuggestedProjectMatch(
  mention: string,
  projects: Project[],
): { id: string; name: string; score: number } | null {
  const match = findBestProjectMatch(mention, projects)
  if (!match || match.score < FUZZY_SUGGEST) return null
  return {
    id: match.project.id,
    name: match.project.title,
    score: Math.round(match.score * 100) / 100,
  }
}
