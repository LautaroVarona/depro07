/**
 * Matchmaker: proyectos validados (extractor) ↔ maestros (manual).
 * Fuzzy siempre; cosine si hay embeddings locales.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Project } from '../types.js'
import { rows, row } from '../sql.js'
import { cosineSimilarity } from './embeddings.js'
import {
  findBestProjectMatch,
  stringSimilarity,
  normalizeName,
} from './entityMatch.js'
import { normalizeProjectKind } from './entityRelations.js'

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

function loadProjectEmbedding(
  db: DatabaseSync,
  projectId: string,
): number[] | null {
  const emb = row<{ vector: string }>(
    db
      .prepare(
        `SELECT vector FROM embeddings
         WHERE object_type = 'project' AND object_id = ?
         LIMIT 1`,
      )
      .get(projectId),
  )
  if (!emb) return null
  const v = parseVec(emb.vector)
  return v.length ? v : null
}

function parseAliasesList(raw: string | null | undefined): string[] {
  try {
    return JSON.parse(raw || '[]') as string[]
  } catch {
    return []
  }
}

export function listMasterProjects(db: DatabaseSync): Project[] {
  return rows<Project>(
    db
      .prepare(
        `SELECT * FROM projects
         WHERE source = 'manual'
           AND (merged_into IS NULL OR merged_into = '')
         ORDER BY title COLLATE NOCASE ASC`,
      )
      .all(),
  ).map((p) => ({
    ...p,
    category: normalizeProjectKind(p.category),
    aliases: p.aliases || '[]',
  }))
}

export function listWaitingProjects(db: DatabaseSync): Project[] {
  return rows<Project>(
    db
      .prepare(
        `SELECT * FROM projects
         WHERE source = 'extractor'
           AND (status IS NULL OR status IN ('active', 'waiting', 'activo', 'emergente', 'pausado', 'cerrado'))
           AND (merged_into IS NULL OR merged_into = '')
         ORDER BY title COLLATE NOCASE ASC`,
      )
      .all(),
  ).map((p) => ({
    ...p,
    category: normalizeProjectKind(p.category),
    aliases: p.aliases || '[]',
  }))
}

export function suggestMasterForWaiting(
  db: DatabaseSync,
  waiting: Project,
  masters: Project[],
): MatchSuggestion | null {
  if (masters.length === 0) return null

  const fuzzy = findBestProjectMatch(waiting.title, masters)
  let best: MatchSuggestion | null = fuzzy
    ? {
        id: fuzzy.project.id,
        name: fuzzy.project.title,
        score: fuzzy.score,
        mode: fuzzy.mode,
      }
    : null

  for (const a of parseAliasesList(waiting.aliases)) {
    const m = findBestProjectMatch(a, masters)
    if (m && (!best || m.score > best.score)) {
      best = {
        id: m.project.id,
        name: m.project.title,
        score: m.score,
        mode: m.mode,
      }
    }
  }

  const wVec = loadProjectEmbedding(db, waiting.id)
  if (wVec) {
    for (const master of masters) {
      const mVec = loadProjectEmbedding(db, master.id)
      if (!mVec || mVec.length !== wVec.length) continue
      const score = cosineSimilarity(wVec, mVec)
      if (!best || score > best.score) {
        best = {
          id: master.id,
          name: master.title,
          score,
          mode: 'embedding',
        }
      }
    }
  }

  const wn = normalizeName(waiting.title)
  for (const master of masters) {
    const score = stringSimilarity(wn, normalizeName(master.title))
    if (score >= SUGGEST_MIN && (!best || score > best.score)) {
      best = {
        id: master.id,
        name: master.title,
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
  Project & {
    suggested_match: MatchSuggestion | null
    link_count: number
    aliases_list: string[]
    evidence_snippet: string | null
    source_file: string | null
  }
> {
  const masters = listMasterProjects(db)
  const waiting = listWaitingProjects(db)
  const linkCount = db.prepare(
    `SELECT COUNT(*) as c FROM entity_links WHERE entity_kind = 'project' AND entity_id = ?`,
  )
  const contextStmt = db.prepare(
    `SELECT e.title as entry_title, e.original_filename, ep.evidence
     FROM entity_links l
     JOIN entries e ON e.id = l.entry_id
     LEFT JOIN entity_proposals ep
       ON ep.matched_entity_id = l.entity_id
      AND ep.kind = 'project'
      AND ep.status = 'approved'
      AND ep.entry_id = l.entry_id
     WHERE l.entity_kind = 'project' AND l.entity_id = ?
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
      aliases_list: parseAliasesList(w.aliases),
      link_count: c?.c ?? 0,
      suggested_match: suggestMasterForWaiting(db, w, masters),
      evidence_snippet: snippet || null,
      source_file: sourceFile,
    }
  })
}
