/**
 * Matchmaker: entidades validadas (extractor) ↔ perfiles maestros (manual).
 * Fuzzy siempre; cosine si hay embeddings locales.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Person } from '../types.js'
import { rows, row } from '../sql.js'
import { cosineSimilarity } from './embeddings.js'
import { findBestPersonMatch, stringSimilarity, normalizeName } from './entityMatch.js'
import { normalizePersonKind, isProfileKind } from './personKinds.js'

export type MatchSuggestion = {
  id: string
  name: string
  score: number
  mode: 'exact' | 'fuzzy' | 'embedding'
}

const SUGGEST_MIN = 0.8
const NICK_MIN = 0.82

function parseVec(raw: string): number[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as number[]) : []
  } catch {
    return []
  }
}

function loadPersonEmbedding(
  db: DatabaseSync,
  personId: string,
): number[] | null {
  const emb = row<{ vector: string }>(
    db
      .prepare(
        `SELECT vector FROM embeddings
         WHERE object_type = 'person' AND object_id = ?
         LIMIT 1`,
      )
      .get(personId),
  )
  if (!emb) return null
  const v = parseVec(emb.vector)
  return v.length ? v : null
}

export function listMasterProfiles(db: DatabaseSync): Person[] {
  return rows<Person>(
    db
      .prepare(
        `SELECT * FROM persons
         WHERE source = 'manual'
           AND (status IS NULL OR status = 'active')
           AND (merged_into IS NULL OR merged_into = '')
           AND kind IN ('fisica','juridica','ficticia','agrupacion')
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(),
  ).map((p) => ({ ...p, kind: normalizePersonKind(p.kind) as Person['kind'] }))
}

export function listWaitingEntities(db: DatabaseSync): Person[] {
  return rows<Person>(
    db
      .prepare(
        `SELECT * FROM persons
         WHERE source = 'extractor'
           AND (status IS NULL OR status IN ('active', 'waiting'))
           AND (merged_into IS NULL OR merged_into = '')
           AND kind IN ('fisica','juridica','ficticia','agrupacion')
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(),
  ).map((p) => ({ ...p, kind: normalizePersonKind(p.kind) as Person['kind'] }))
}

export function suggestMasterForWaiting(
  db: DatabaseSync,
  waiting: Person,
  masters: Person[],
): MatchSuggestion | null {
  if (masters.length === 0) return null

  const fuzzy = findBestPersonMatch(waiting.name, masters)
  let best: MatchSuggestion | null = fuzzy
    ? {
        id: fuzzy.person.id,
        name: fuzzy.person.name,
        score: fuzzy.score,
        mode: fuzzy.mode,
      }
    : null

  // Refinar con aliases de la entidad en espera
  let aliases: string[] = []
  try {
    aliases = JSON.parse(waiting.aliases || '[]') as string[]
  } catch {
    aliases = []
  }
  for (const a of aliases) {
    const m = findBestPersonMatch(a, masters)
    if (m && (!best || m.score > best.score)) {
      best = {
        id: m.person.id,
        name: m.person.name,
        score: m.score,
        mode: m.mode,
      }
    }
  }

  // Cosine si hay embeddings
  const wVec = loadPersonEmbedding(db, waiting.id)
  if (wVec) {
    for (const master of masters) {
      const mVec = loadPersonEmbedding(db, master.id)
      if (!mVec || mVec.length !== wVec.length) continue
      const score = cosineSimilarity(wVec, mVec)
      if (!best || score > best.score) {
        best = {
          id: master.id,
          name: master.name,
          score,
          mode: 'embedding',
        }
      }
    }
  }

  // Refuerzo: similitud directa nombre↔nombre
  const wn = normalizeName(waiting.name)
  for (const master of masters) {
    if (!isProfileKind(normalizePersonKind(master.kind))) continue
    const score = stringSimilarity(wn, normalizeName(master.name))
    if (score >= SUGGEST_MIN && (!best || score > best.score)) {
      best = {
        id: master.id,
        name: master.name,
        score,
        mode: 'fuzzy',
      }
    }
  }

  if (!best || best.score < NICK_MIN) return null
  return {
    ...best,
    score: Math.round(best.score * 100) / 100,
  }
}

function parseEvidenceSnippet(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { snippet?: string; mention?: string }
    return (parsed.snippet || parsed.mention || '').trim()
  } catch {
    return raw.trim()
  }
}

export function buildWaitingWithMatches(db: DatabaseSync): Array<
  Person & {
    suggested_match: MatchSuggestion | null
    link_count: number
    evidence_snippet: string | null
    source_file: string | null
  }
> {
  const masters = listMasterProfiles(db)
  const waiting = listWaitingEntities(db)
  const linkCount = db.prepare(
    `SELECT COUNT(*) as c FROM entity_links WHERE entity_kind = 'person' AND entity_id = ?`,
  )
  const contextStmt = db.prepare(
    `SELECT e.title as entry_title, e.original_filename, ep.evidence
     FROM entity_links l
     JOIN entries e ON e.id = l.entry_id
     LEFT JOIN entity_proposals ep
       ON ep.matched_entity_id = l.entity_id
      AND ep.kind = 'person'
      AND ep.status = 'approved'
      AND ep.entry_id = l.entry_id
     WHERE l.entity_kind = 'person' AND l.entity_id = ?
     ORDER BY l.created_at DESC
     LIMIT 1`,
  )

  return waiting.map((w) => {
    const c = row<{ c: number }>(linkCount.get(w.id))
    const ctx = row<{
      entry_title: string
      original_filename: string | null
      evidence: string | null
    }>(contextStmt.get(w.id))
    const snippet = parseEvidenceSnippet(ctx?.evidence)
    const sourceFile =
      (ctx?.original_filename || ctx?.entry_title || '').trim() || null

    return {
      ...w,
      aliases_list: (() => {
        try {
          return JSON.parse(w.aliases || '[]') as string[]
        } catch {
          return []
        }
      })(),
      link_count: c?.c ?? 0,
      suggested_match: suggestMasterForWaiting(db, w, masters),
      evidence_snippet: snippet || null,
      source_file: sourceFile,
    }
  })
}
