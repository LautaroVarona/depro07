/**
 * Cosecha y normalización de URLs + backfill desde corpus existente.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../db.js'
import { rows } from '../sql.js'
import type { LinkHarvest, LinkHarvestSourceType } from '../types.js'

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'igsh',
  'igshid',
  'si',
  's',
  't',
  'ref',
  'ref_src',
  'ref_url',
])

export function extractUrls(text: string): string[] {
  if (!text) return []
  const found = text.match(URL_RE) ?? []
  return found.map((u) => u.replace(/[.,;:!?)]+$/, '')).filter(Boolean)
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  try {
    const u = new URL(trimmed)
    u.hash = ''
    const keep = new URLSearchParams()
    for (const [k, v] of u.searchParams.entries()) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) keep.set(k, v)
    }
    u.search = keep.toString() ? `?${keep.toString()}` : ''
    let host = u.hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    const path = u.pathname.replace(/\/+$/, '') || ''
    return `${u.protocol}//${host}${path}${u.search}`
  } catch {
    return trimmed.toLowerCase()
  }
}

export type LinkInsertInput = {
  url_cruda: string
  source_type: LinkHarvestSourceType
  source_id: string
  remitente?: string | null
  timestamp_captura?: string | null
  chat_session_id?: string | null
}

export function insertLinkHarvest(
  db: DatabaseSync,
  input: LinkInsertInput,
): boolean {
  const url_norm = normalizeUrl(input.url_cruda)
  if (!url_norm) return false
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO link_harvest (
        id, url_cruda, url_norm, source_type, source_id, remitente,
        timestamp_captura, chat_session_id, estado_crawler, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`,
    ).run(
      randomUUID(),
      input.url_cruda,
      url_norm,
      input.source_type,
      input.source_id,
      input.remitente ?? null,
      input.timestamp_captura ?? null,
      input.chat_session_id ?? null,
      now,
    )
    return true
  } catch {
    return false
  }
}

export function insertLinksFromText(
  db: DatabaseSync,
  text: string,
  meta: Omit<LinkInsertInput, 'url_cruda'>,
): number {
  let n = 0
  for (const url of extractUrls(text)) {
    if (insertLinkHarvest(db, { ...meta, url_cruda: url })) n++
  }
  return n
}

export function listLinks(opts?: {
  q?: string
  estado?: string
  source_type?: string
  limit?: number
}): { links: LinkHarvest[]; total: number } {
  const db = getDb()
  const where: string[] = ['1=1']
  const params: string[] = []
  if (opts?.q?.trim()) {
    where.push('(l.url_cruda LIKE ? OR l.url_norm LIKE ? OR COALESCE(l.remitente, "") LIKE ?)')
    const like = `%${opts.q.trim()}%`
    params.push(like, like, like)
  }
  if (opts?.estado?.trim()) {
    where.push('l.estado_crawler = ?')
    params.push(opts.estado.trim())
  }
  if (opts?.source_type?.trim()) {
    where.push('l.source_type = ?')
    params.push(opts.source_type.trim())
  }
  const whereSql = where.join(' AND ')
  const total = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM link_harvest l WHERE ${whereSql}`)
        .get(...params) as { n: number | bigint }
    ).n ?? 0,
  )
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 2000)
  const links = rows<LinkHarvest & { chat_nombre?: string | null }>(
    db
      .prepare(
        `SELECT l.*, s.nombre_chat AS chat_nombre
         FROM link_harvest l
         LEFT JOIN chat_sessions s ON s.id = l.chat_session_id
         WHERE ${whereSql}
         ORDER BY COALESCE(l.timestamp_captura, l.created_at) DESC
         LIMIT ?`,
      )
      .all(...params, limit),
  )
  return { links, total }
}

export function backfillLinksFromCorpus(): {
  scanned: number
  inserted: number
} {
  const db = getDb()
  let scanned = 0
  let inserted = 0

  const quantomos = rows<{
    id: string
    title: string
    content: string | null
  }>(
    db
      .prepare(`SELECT id, title, content FROM quantomos`)
      .all(),
  )
  for (const q of quantomos) {
    scanned++
    const text = `${q.title}\n${q.content ?? ''}`
    inserted += insertLinksFromText(db, text, {
      source_type: 'quantomo',
      source_id: q.id,
      timestamp_captura: null,
    })
  }

  const entries = rows<{
    id: string
    content_raw: string | null
    timestamp_exact: string | null
  }>(
    db
      .prepare(
        `SELECT id, content_raw, timestamp_exact FROM entries
         WHERE content_raw IS NOT NULL AND content_raw != ''`,
      )
      .all(),
  )
  for (const e of entries) {
    scanned++
    inserted += insertLinksFromText(db, e.content_raw ?? '', {
      source_type: 'entry',
      source_id: e.id,
      timestamp_captura: e.timestamp_exact,
    })
  }

  const bookmarks = rows<{
    id: string
    link: string | null
    created_at_source: string | null
    author_name: string | null
  }>(
    db
      .prepare(
        `SELECT id, link, created_at_source, author_name FROM bookmarks
         WHERE link IS NOT NULL AND link != ''`,
      )
      .all(),
  )
  for (const b of bookmarks) {
    scanned++
    if (!b.link) continue
    if (
      insertLinkHarvest(db, {
        url_cruda: b.link,
        source_type: 'bookmark',
        source_id: b.id,
        remitente: b.author_name,
        timestamp_captura: b.created_at_source,
      })
    ) {
      inserted++
    }
  }

  return { scanned, inserted }
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
