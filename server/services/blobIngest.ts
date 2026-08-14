import { randomUUID } from 'node:crypto'
import { getDb, getTrincheraNotebookId } from '../db.js'
import { row, rows } from '../sql.js'
import { clampTitleWords } from './titleUtils.js'
import { embedApprovedEntry, enqueueEmbed } from './embeddings.js'
import { extractFromTranscript } from './cohere.js'
import type { CohereQuantomo } from '../types.js'

export type BlobTagKind = 'person' | 'project' | 'agrupacion'

export type BlobTag = {
  kind: BlobTagKind
  entity_id: string
  entity_name: string
}

export type BlobView = {
  id: string
  title: string
  content_raw: string
  timestamp_exact: string
  created_at: string
  quantomo_id: string | null
  quantomos: Array<{ id: string; title: string; content: string | null }>
  tags: BlobTag[]
}

function parseTimestamp(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return fallback
  return d.toISOString()
}

function parseTags(raw: unknown): BlobTag[] {
  if (!Array.isArray(raw)) return []
  const out: BlobTag[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const kind =
      o.kind === 'project'
        ? 'project'
        : o.kind === 'agrupacion'
          ? 'agrupacion'
          : o.kind === 'person'
            ? 'person'
            : null
    const entity_id = String(o.entity_id ?? '').trim()
    const entity_name = String(o.entity_name ?? '').trim()
    if (!kind || !entity_id) continue
    const key = `${kind}:${entity_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, entity_id, entity_name: entity_name || entity_id })
  }
  return out
}

function resolveTagName(
  kind: BlobTagKind,
  entityId: string,
  fallback: string,
): string | null {
  const db = getDb()
  if (kind === 'person') {
    const p = row<{ name: string }>(
      db
        .prepare(
          `SELECT name FROM persons
           WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
        )
        .get(entityId),
    )
    return p?.name ?? null
  }
  if (kind === 'project') {
    const p = row<{ title: string }>(
      db
        .prepare(
          `SELECT title FROM projects
           WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
        )
        .get(entityId),
    )
    return p?.title ?? null
  }
  const a = row<{ name: string }>(
    db.prepare(`SELECT name FROM agrupaciones WHERE id = ?`).get(entityId),
  )
  return a?.name ?? (fallback || null)
}

function insertLink(
  entityKind: BlobTagKind,
  entityId: string,
  entryId: string,
  quantomoId: string,
  role: string,
  now: string,
): boolean {
  const db = getDb()
  const already = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM entity_links
         WHERE entity_kind = ? AND entity_id = ? AND entry_id = ?`,
      )
      .get(entityKind, entityId, entryId),
  )
  if (already) return false
  db.prepare(
    `INSERT INTO entity_links (
      id, entity_kind, entity_id, entry_id, quantomo_id, role, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), entityKind, entityId, entryId, quantomoId, role, now)
  return true
}

export function applyEntityMentionTags(
  tags: BlobTag[],
  entryId: string,
  quantomoId: string,
  now: string,
): BlobTag[] {
  const applied: BlobTag[] = []
  for (const tag of tags) {
    const name = resolveTagName(tag.kind, tag.entity_id, tag.entity_name)
    if (!name) continue
    insertLink(tag.kind, tag.entity_id, entryId, quantomoId, 'mentioned', now)
    applied.push({ kind: tag.kind, entity_id: tag.entity_id, entity_name: name })

    if (tag.kind !== 'agrupacion') continue
    const members = rows<{ person_id: string }>(
      getDb()
        .prepare(
          `SELECT person_id FROM agrupacion_members WHERE agrupacion_id = ?`,
        )
        .all(tag.entity_id),
    )
    for (const m of members) {
      const personName = resolveTagName('person', m.person_id, '')
      if (!personName) continue
      insertLink(
        'person',
        m.person_id,
        entryId,
        quantomoId,
        'via_agrupacion',
        now,
      )
    }
  }
  return applied
}

export function listEntryTags(entryId: string): BlobTag[] {
  const db = getDb()
  return rows<{
    entity_kind: string
    entity_id: string
    entity_name: string | null
  }>(
    db
      .prepare(
        `SELECT
           l.entity_kind,
           l.entity_id,
           CASE
             WHEN l.entity_kind = 'person' THEN p.name
             WHEN l.entity_kind = 'project' THEN proj.title
             WHEN l.entity_kind = 'agrupacion' THEN a.name
             ELSE l.entity_id
           END AS entity_name
         FROM entity_links l
         LEFT JOIN persons p
           ON l.entity_kind = 'person' AND p.id = l.entity_id
         LEFT JOIN projects proj
           ON l.entity_kind = 'project' AND proj.id = l.entity_id
         LEFT JOIN agrupaciones a
           ON l.entity_kind = 'agrupacion' AND a.id = l.entity_id
         WHERE l.entry_id = ? AND l.role = 'mentioned'
         ORDER BY l.created_at ASC`,
      )
      .all(entryId),
  )
    .filter((r) => r.entity_name)
    .map((r) => ({
      kind: r.entity_kind as BlobTagKind,
      entity_id: r.entity_id,
      entity_name: r.entity_name as string,
    }))
}

function distillQuantomo(text: string): CohereQuantomo {
  const firstLine =
    text.split(/\n/).find((l) => l.replace(/@/g, '').trim())?.trim() ||
    'Nota en bruto'
  const title = clampTitleWords(firstLine, 3, 6, 'Nota en bruto')
  const para = (text.split(/\n\s*\n/)[0] ?? text).trim()
  const content =
    para.length > 520 ? `${para.slice(0, 500).trim()}…` : para || title
  return {
    title,
    content,
    hermetic_weight: 7,
    universe: 'nota',
  }
}

function listQuantomos(entryId: string): Array<{
  id: string
  title: string
  content: string | null
}> {
  return rows<{ id: string; title: string; content: string | null }>(
    getDb()
      .prepare(
        `SELECT id, title, content FROM quantomos
         WHERE entry_id = ? AND recognized = 1
         ORDER BY rowid ASC`,
      )
      .all(entryId),
  )
}

function toView(
  e: {
    id: string
    title: string
    content_raw: string
    timestamp_exact: string
    created_at: string
  },
): BlobView {
  const quantomos = listQuantomos(e.id)
  return {
    id: e.id,
    title: e.title,
    content_raw: e.content_raw,
    timestamp_exact: e.timestamp_exact,
    created_at: e.created_at,
    quantomo_id: quantomos[0]?.id ?? null,
    quantomos,
    tags: listEntryTags(e.id),
  }
}

export function listBlobs(limit = 40): BlobView[] {
  const cap = Math.min(Math.max(limit, 1), 100)
  const entries = rows<{
    id: string
    title: string
    content_raw: string | null
    timestamp_exact: string | null
    created_at: string
    quantomo_id: string | null
  }>(
    getDb()
      .prepare(
        `SELECT e.id, e.title, e.content_raw, e.timestamp_exact, e.created_at,
                (SELECT q.id FROM quantomos q WHERE q.entry_id = e.id LIMIT 1)
                  AS quantomo_id
         FROM entries e
         WHERE e.source_type = 'blob'
         ORDER BY e.timestamp_exact DESC, e.created_at DESC
         LIMIT ?`,
      )
      .all(cap),
  )

  return entries.map((e) =>
    toView({
      id: e.id,
      title: e.title,
      content_raw: e.content_raw ?? '',
      timestamp_exact: e.timestamp_exact ?? e.created_at,
      created_at: e.created_at,
    }),
  )
}

export function ingestBlob(input: {
  text: string
  timestamp_exact?: string
  tags?: unknown
}): BlobView {
  const text = input.text.replace(/\r\n/g, '\n').trimEnd()
  if (!text.trim()) {
    throw new Error('texto vacío')
  }

  const now = new Date().toISOString()
  const timestamp = parseTimestamp(input.timestamp_exact, now)
  const tags = parseTags(input.tags)
  const distilled = distillQuantomo(text)
  const title = distilled.title
  const entryId = randomUUID()
  const quantomoId = randomUUID()
  const notebookId = getTrincheraNotebookId()
  const db = getDb()

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO entries (
        id, notebook_id, source_type, title, content_raw, vault_path,
        timestamp_exact, status, created_at, title_manual, original_filename
      ) VALUES (?, ?, 'blob', ?, ?, NULL, ?, 'approved', ?, 1, NULL)`,
    ).run(entryId, notebookId, title, text, timestamp, now)

    db.prepare(
      `INSERT INTO quantomos (
        id, entry_id, title, content, hermetic_weight, universe, recognized,
        human_weight, suggested_weight
      ) VALUES (?, ?, ?, ?, ?, 'nota', 1, ?, ?)`,
    ).run(
      quantomoId,
      entryId,
      distilled.title,
      distilled.content,
      distilled.hermetic_weight,
      distilled.hermetic_weight,
      distilled.hermetic_weight,
    )

    applyEntityMentionTags(tags, entryId, quantomoId, now)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  enqueueEmbed(async () => {
    try {
      const extraction = await extractFromTranscript(text, title, {
        fallback: 'none',
      })
      const extras = extraction.quantomos
        .map((q) => ({
          title: clampTitleWords(q.title, 3, 6, distilled.title),
          content: String(q.content ?? '').trim(),
          hermetic_weight: Number(q.hermetic_weight ?? 7) || 7,
          universe: (q.universe || 'nota').trim() || 'nota',
        }))
        .filter((q) => q.content && q.content !== distilled.content)
      if (extras.length > 0) {
        const conn = getDb()
        conn
          .prepare(
            `UPDATE quantomos SET title = ?, content = ?, hermetic_weight = ?,
                    universe = ?, human_weight = ?, suggested_weight = ?
             WHERE id = ?`,
          )
          .run(
            extras[0]!.title,
            extras[0]!.content,
            extras[0]!.hermetic_weight,
            extras[0]!.universe,
            extras[0]!.hermetic_weight,
            extras[0]!.hermetic_weight,
            quantomoId,
          )
        for (const extra of extras.slice(1)) {
          conn
            .prepare(
              `INSERT INTO quantomos (
                id, entry_id, title, content, hermetic_weight, universe, recognized,
                human_weight, suggested_weight
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              randomUUID(),
              entryId,
              extra.title,
              extra.content,
              extra.hermetic_weight,
              extra.universe,
              extra.hermetic_weight,
              extra.hermetic_weight,
            )
        }
      }
    } catch (err) {
      console.warn('[blob] extract quantomo:', err)
    }
    await embedApprovedEntry(entryId)
  })

  return toView({
    id: entryId,
    title,
    content_raw: text,
    timestamp_exact: timestamp,
    created_at: now,
  })
}
