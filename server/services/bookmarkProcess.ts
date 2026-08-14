/**
 * Promoción de bookmarks cribados → entry + quantomo + proposals.
 * Twitter: peso >= 7 (texto).
 * Instagram: bandas 1–3 slop, 4–6 texto, 7–9 + STT, 10–12 + OCR.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, getTrincheraNotebookId } from '../db.js'
import { rows } from '../sql.js'
import type {
  Bookmark,
  BookmarkManualTag,
  BookmarkSource,
  BookmarkSuggestedLink,
  Person,
  Project,
} from '../types.js'
import {
  analyzeReelFrames,
  extractFromBookmark,
  extractFromInstagramReel,
} from './cohere.js'
import { transcribeAudio } from './deepgram.js'
import {
  createEntityProposalsFromEntry,
  findBestPersonMatch,
  findBestProjectMatch,
} from './entityMatch.js'
import {
  embedApprovedEntry,
  enqueueEmbed,
} from './embeddings.js'
import {
  ensureReelMedia,
  extractFramesEveryNSeconds,
  hasFfmpeg,
  instagramVaultDir,
} from './instagramMedia.js'
import { clampTitleWords } from './titleUtils.js'
import { filterSourceAuthorEntities } from './nerGuards.js'

const FUZZY_SUGGEST = 0.68

/** Quita al autor del post de las entidades NER (Twitter / Instagram). */
function dropAuthorEntities<T extends { name: string }>(
  entities: T[],
  bookmark: Pick<Bookmark, 'author_name' | 'author_username'>,
): T[] {
  return filterSourceAuthorEntities(
    entities,
    bookmark.author_name,
    bookmark.author_username,
  )
}

export type ProcessHighValueResult = {
  processed: number
  skipped: number
  errors: Array<{ id: string; error: string }>
  ids: string[]
  items: Array<{
    id: string
    weight: number
    category: string
    quantomo: string
    quantomo_id: string
    entry_id: string
    title: string
  }>
}

export type NormalizedImportItem = {
  id: string
  text: string
  author_name: string | null
  author_username: string | null
  created_at_source: string | null
  link: string | null
  media_urls: string
  source: BookmarkSource
  shortcode: string | null
  media_pk: string | null
  likes: number | null
  comments: number | null
}

function parseMediaUrls(raw: unknown): string {
  if (Array.isArray(raw)) {
    return JSON.stringify(raw.map(String).filter(Boolean))
  }
  if (typeof raw !== 'string' || !raw.trim()) return '[]'
  const t = raw.trim()
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed.map(String).filter(Boolean))
      }
    } catch {
      /* fallthrough */
    }
  }
  if (t.includes('|')) {
    return JSON.stringify(t.split('|').map((s) => s.trim()).filter(Boolean))
  }
  if (t.includes(',')) {
    return JSON.stringify(t.split(',').map((s) => s.trim()).filter(Boolean))
  }
  return JSON.stringify([t])
}

function isInstagramShape(raw: Record<string, unknown>): boolean {
  const hasDesc =
    raw.descripcion_reel != null ||
    raw.descripcionReel != null ||
    raw.description_reel != null
  const hasUrl = raw.url_video != null || raw.urlVideo != null
  const hasCode = raw.shortcode != null || raw.short_code != null
  return Boolean(hasDesc && (hasUrl || hasCode))
}

function normalizeInstagramItem(
  raw: Record<string, unknown>,
): NormalizedImportItem | null {
  const shortcode = String(
    raw.shortcode ?? raw.short_code ?? '',
  )
    .trim()
  const mediaPk = String(raw.media_pk ?? raw.mediaPk ?? '').trim() || null
  const desc = String(
    raw.descripcion_reel ??
      raw.descripcionReel ??
      raw.description_reel ??
      raw.text ??
      '',
  ).trim()
  if (!shortcode || !desc) return null

  const url =
    String(raw.url_video ?? raw.urlVideo ?? raw.link ?? '').trim() ||
    `https://www.instagram.com/reel/${shortcode}/`
  const autor = String(raw.autor ?? raw.author ?? '').trim() || null
  const likesRaw = Number(raw.likes)
  const commentsRaw = Number(raw.comments)

  return {
    id: `ig:${shortcode}`,
    text: desc,
    author_name: null,
    author_username: autor?.replace(/^@/, '') || null,
    created_at_source:
      String(raw.fecha_mensaje ?? raw.fechaMensaje ?? raw.createdAt ?? '').trim() ||
      null,
    link: url,
    media_urls: JSON.stringify([url]),
    source: 'instagram',
    shortcode,
    media_pk: mediaPk,
    likes: Number.isFinite(likesRaw) ? likesRaw : null,
    comments: Number.isFinite(commentsRaw) ? commentsRaw : null,
  }
}

export function normalizeImportItem(
  raw: Record<string, unknown>,
): NormalizedImportItem | null {
  if (isInstagramShape(raw)) {
    return normalizeInstagramItem(raw)
  }

  const id = String(raw.id ?? raw.tweet_id ?? raw.tweetId ?? '').trim()
  const text = String(raw.text ?? raw.full_text ?? raw.fullText ?? '').trim()
  if (!id || !text) return null

  // Evitar colisión si alguien manda id numérico suelto sin shape IG
  if (String(raw.source ?? '').toLowerCase() === 'instagram') {
    return null
  }

  return {
    id,
    text,
    author_name: String(
      raw.authorName ?? raw.author_name ?? raw.author ?? '',
    ).trim() || null,
    author_username: String(
      raw.authorUsername ?? raw.author_username ?? raw.username ?? '',
    )
      .trim()
      .replace(/^@/, '') || null,
    created_at_source: String(
      raw.createdAt ?? raw.created_at ?? raw.created_at_source ?? '',
    ).trim() || null,
    link: String(raw.link ?? raw.url ?? raw.expanded_url ?? '').trim() || null,
    media_urls: parseMediaUrls(raw.mediaUrls ?? raw.media_urls ?? ''),
    source: 'twitter',
    shortcode: null,
    media_pk: null,
    likes: null,
    comments: null,
  }
}

/** Parser CSV mínimo con soporte de comillas y saltos de línea en campos. */
export function parseCsv(text: string): Record<string, string>[] {
  const rowsOut: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((cell) => cell.trim().length > 0)) rowsOut.push(row)
      row = []
      continue
    }
    field += c
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (row.some((cell) => cell.trim().length > 0)) rowsOut.push(row)
  }

  if (rowsOut.length === 0) return []
  const headers = rowsOut[0]!.map((h) => h.trim())
  return rowsOut.slice(1).map((cells) => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]!] = cells[i] ?? ''
    }
    return obj
  })
}

export function parseBookmarkPayload(
  raw: string,
  filenameHint = '',
): Record<string, unknown>[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  const looksJson =
    filenameHint.toLowerCase().endsWith('.json') ||
    trimmed.startsWith('[') ||
    trimmed.startsWith('{')

  if (looksJson) {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[]
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { items?: unknown; bookmarks?: unknown }
      if (Array.isArray(obj.items)) return obj.items as Record<string, unknown>[]
      if (Array.isArray(obj.bookmarks)) {
        return obj.bookmarks as Record<string, unknown>[]
      }
      return [parsed as Record<string, unknown>]
    }
    return []
  }

  return parseCsv(trimmed) as Record<string, unknown>[]
}

function bookmarkSource(b: Bookmark): BookmarkSource {
  return b.source === 'instagram' ? 'instagram' : 'twitter'
}

function buildSuggestedLinks(
  db: DatabaseSync,
  entities: Array<{ name: string; type: string }>,
): BookmarkSuggestedLink[] {
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

  const out: BookmarkSuggestedLink[] = []
  const seen = new Set<string>()

  for (const e of entities) {
    const name = e.name.trim()
    if (!name) continue

    if (e.type === 'person' || e.type === 'project') {
      const pMatch = findBestPersonMatch(name, persons)
      if (pMatch && pMatch.score >= FUZZY_SUGGEST) {
        const key = `person:${pMatch.person.id}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'person',
            label: name,
            entity_id: pMatch.person.id,
            entity_name: pMatch.person.name,
            score: pMatch.score,
            suggestion: `Sugerencia: Vincular a Persona: ${pMatch.person.name}`,
          })
        }
      }
      const jMatch = findBestProjectMatch(name, projects)
      if (jMatch && jMatch.score >= FUZZY_SUGGEST) {
        const key = `project:${jMatch.project.id}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'project',
            label: name,
            entity_id: jMatch.project.id,
            entity_name: jMatch.project.title,
            score: jMatch.score,
            suggestion: `Sugerencia: Vincular a Proyecto: ${jMatch.project.title}`,
          })
        }
      }
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 12)
}

export function parseManualTags(raw: string | null | undefined): BookmarkManualTag[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: BookmarkManualTag[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const kind = o.kind === 'project' ? 'project' : o.kind === 'person' ? 'person' : null
      const entity_id = String(o.entity_id ?? '').trim()
      const entity_name = String(o.entity_name ?? '').trim()
      if (!kind || !entity_id || !entity_name) continue
      out.push({ kind, entity_id, entity_name })
    }
    return out
  } catch {
    return []
  }
}

/** Vincula tags @ de criba al entry (idempotente). */
export function applyManualTagsAsLinks(
  db: DatabaseSync,
  bookmark: Pick<Bookmark, 'manual_tags'>,
  entryId: string,
  quantomoId: string | null,
): number {
  const tags = parseManualTags(bookmark.manual_tags)
  if (tags.length === 0) return 0
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO entity_links (
      id, entity_kind, entity_id, entry_id, quantomo_id, role, created_at
    ) VALUES (?, ?, ?, ?, ?, 'mentioned', ?)
  `)
  let linked = 0
  for (const tag of tags) {
    if (tag.kind === 'person') {
      const exists = db.prepare(`SELECT id FROM persons WHERE id = ?`).get(tag.entity_id)
      if (!exists) continue
    } else {
      const exists = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(tag.entity_id)
      if (!exists) continue
    }
    const already = db
      .prepare(
        `SELECT id FROM entity_links
         WHERE entity_kind = ? AND entity_id = ? AND entry_id = ?`,
      )
      .get(tag.kind, tag.entity_id, entryId)
    if (already) continue
    insert.run(
      randomUUID(),
      tag.kind,
      tag.entity_id,
      entryId,
      quantomoId,
      now,
    )
    linked += 1
  }
  return linked
}

function withOperatorNote(base: string, note: string | null | undefined): string {
  const n = (note ?? '').trim()
  if (!n) return base
  return `${base}\n\n--- Nota operador ---\n${n}`
}

type ProcessItemResult = {
  id: string
  weight: number
  category: string
  quantomo: string
  quantomo_id: string
  entry_id: string
  title: string
}

async function processOneTwitterBookmark(
  db: DatabaseSync,
  bookmark: Bookmark,
): Promise<ProcessItemResult> {
  if (bookmark.weight == null || bookmark.weight < 7) {
    throw new Error('peso insuficiente')
  }
  if (bookmark.status === 'PROCESADO_IA') {
    throw new Error('ya procesado')
  }

  const author =
    [bookmark.author_name, bookmark.author_username]
      .filter(Boolean)
      .join(' @') || undefined

  const extraction = await extractFromBookmark(bookmark.text, {
    author,
    link: bookmark.link ?? undefined,
  })
  extraction.entities = dropAuthorEntities(extraction.entities, bookmark)

  const entryId = randomUUID()
  const quantomoId = randomUUID()
  const notebookId = getTrincheraNotebookId()
  const now = new Date().toISOString()
  const title = clampTitleWords(
    extraction.suggested_title,
    3,
    5,
    'Bookmark importado X',
  )
  const humanWeight = Math.max(1, Math.min(12, bookmark.weight))
  const suggestedWeight = extraction.suggested_weight

  const entitiesForStore = extraction.entities.map((e) => ({
    name: e.name,
    type: e.type,
    kind: e.kind ?? null,
  }))
  const suggestedLinks = buildSuggestedLinks(db, extraction.entities)

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO entries (
        id, notebook_id, source_type, title, content_raw, vault_path,
        timestamp_exact, status, created_at, title_manual, original_filename
      ) VALUES (?, ?, 'bookmark', ?, ?, NULL, ?, 'approved', ?, 1, ?)`,
    ).run(
      entryId,
      notebookId,
      title,
      withOperatorNote(bookmark.text, bookmark.operator_note),
      bookmark.created_at_source || now,
      now,
      bookmark.link || `bookmark:${bookmark.id}`,
    )

    db.prepare(
      `INSERT INTO quantomos (
        id, entry_id, title, content, hermetic_weight, universe, recognized,
        human_weight, suggested_weight
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      quantomoId,
      entryId,
      title,
      extraction.quantomo,
      humanWeight,
      extraction.category,
      humanWeight,
      suggestedWeight,
    )

    const insertEntityRaw = db.prepare(`
      INSERT INTO entry_entities_raw (id, entry_id, name, type, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const e of extraction.entities) {
      insertEntityRaw.run(
        randomUUID(),
        entryId,
        e.name,
        e.type,
        JSON.stringify({
          kind: e.kind,
          category: e.category,
          status: e.status,
        }),
      )
    }

    createEntityProposalsFromEntry(db, entryId)
    applyManualTagsAsLinks(db, bookmark, entryId, quantomoId)

    db.prepare(
      `UPDATE bookmarks SET
        status = 'PROCESADO_IA',
        category = ?,
        extracted_entities = ?,
        suggested_links = ?,
        quantomo = ?,
        entry_id = ?,
        quantomo_id = ?
       WHERE id = ?`,
    ).run(
      extraction.category,
      JSON.stringify(entitiesForStore),
      JSON.stringify(suggestedLinks),
      extraction.quantomo,
      entryId,
      quantomoId,
      bookmark.id,
    )

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    id: bookmark.id,
    weight: humanWeight,
    category: extraction.category,
    quantomo: extraction.quantomo,
    quantomo_id: quantomoId,
    entry_id: entryId,
    title,
  }
}

async function processOneInstagramBookmark(
  db: DatabaseSync,
  bookmark: Bookmark,
): Promise<ProcessItemResult | null> {
  if (bookmark.weight == null) {
    throw new Error('sin peso')
  }
  if (bookmark.status === 'PROCESADO_IA' || bookmark.status === 'SLOP') {
    throw new Error('ya procesado')
  }

  const humanWeight = Math.max(1, Math.min(12, bookmark.weight))

  // 1–3 → slop
  if (humanWeight <= 3) {
    db.prepare(`UPDATE bookmarks SET status = 'SLOP' WHERE id = ?`).run(
      bookmark.id,
    )
    return null
  }

  let transcript: string | null = bookmark.transcript ?? null
  let ocrFrames: Array<{ t_sec: number; explanation: string }> = []
  let localMediaPath = bookmark.local_media_path
  let vaultPathForEntry: string | null = null

  if (humanWeight >= 7) {
    const media = await ensureReelMedia(bookmark)
    if (media.ok) {
      localMediaPath = media.relativePath
      vaultPathForEntry = media.relativePath
      const { text } = await transcribeAudio(media.absPath, bookmark.id)
      transcript = text || null
      if (transcript) {
        db.prepare(`UPDATE bookmarks SET transcript = ? WHERE id = ?`).run(
          transcript,
          bookmark.id,
        )
      }
    } else {
      console.warn(
        `[ig-process] media skip «${bookmark.id}»: ${media.error}`,
      )
    }
  }

  if (humanWeight >= 10 && localMediaPath) {
    const abs = path.resolve(process.cwd(), localMediaPath)
    const framesDir = path.join(instagramVaultDir(bookmark.id), 'frames')
    const frames = await extractFramesEveryNSeconds(abs, framesDir, 3)
    // Limitar fotogramas para no explotar costos Vision
    const capped = frames.slice(0, 20)
    const analyzed = await analyzeReelFrames(capped)
    ocrFrames = analyzed.map((f) => ({
      t_sec: f.t_sec,
      explanation: f.explanation,
    }))
    db.prepare(`UPDATE bookmarks SET ocr_json = ? WHERE id = ?`).run(
      JSON.stringify(
        analyzed.map((f) => ({
          t_sec: f.t_sec,
          path: path.relative(process.cwd(), f.path).replace(/\\/g, '/'),
          explanation: f.explanation,
        })),
      ),
      bookmark.id,
    )
  }

  const author = bookmark.author_username
    ? `@${bookmark.author_username}`
    : undefined

  const extraction = await extractFromInstagramReel({
    description: bookmark.text,
    transcript: humanWeight >= 7 ? transcript : null,
    ocrFrames: humanWeight >= 10 ? ocrFrames : undefined,
    author,
    link: bookmark.link ?? undefined,
  })
  extraction.entities = dropAuthorEntities(extraction.entities, bookmark)

  const entryId = randomUUID()
  const quantomoId = randomUUID()
  const notebookId = getTrincheraNotebookId()
  const now = new Date().toISOString()
  const title = clampTitleWords(
    extraction.suggested_title,
    1,
    3,
    'Reel Instagram',
  )
  const suggestedWeight = extraction.suggested_weight

  const contentParts = [bookmark.text]
  if (transcript) contentParts.push(`\n\n--- Transcript ---\n${transcript}`)
  if (extraction.audio_summary) {
    contentParts.push(`\n\n--- Audio summary ---\n${extraction.audio_summary}`)
  }
  if (extraction.video_meta) {
    contentParts.push(`\n\n--- Video meta ---\n${extraction.video_meta}`)
  }
  if (ocrFrames.length > 0) {
    contentParts.push(
      `\n\n--- OCR frames ---\n${ocrFrames
        .map((f) => `[${f.t_sec}s] ${f.explanation}`)
        .join('\n')}`,
    )
  }
  const contentRaw = withOperatorNote(
    contentParts.join(''),
    bookmark.operator_note,
  )

  const enrichment = {
    band:
      humanWeight >= 10 ? '10-12' : humanWeight >= 7 ? '7-9' : '4-6',
    audio_summary: extraction.audio_summary ?? null,
    video_meta: extraction.video_meta ?? null,
    has_transcript: Boolean(transcript),
    ocr_frame_count: ocrFrames.length,
  }

  const entitiesForStore = extraction.entities.map((e) => ({
    name: e.name,
    type: e.type,
    kind: e.kind ?? null,
  }))
  const suggestedLinks = buildSuggestedLinks(db, extraction.entities)

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO entries (
        id, notebook_id, source_type, title, content_raw, vault_path,
        timestamp_exact, status, created_at, title_manual, original_filename
      ) VALUES (?, ?, 'instagram', ?, ?, ?, ?, 'approved', ?, 1, ?)`,
    ).run(
      entryId,
      notebookId,
      title,
      contentRaw,
      vaultPathForEntry,
      bookmark.created_at_source || now,
      now,
      bookmark.link || `instagram:${bookmark.id}`,
    )

    db.prepare(
      `INSERT INTO quantomos (
        id, entry_id, title, content, hermetic_weight, universe, recognized,
        human_weight, suggested_weight
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      quantomoId,
      entryId,
      title,
      extraction.quantomo,
      humanWeight,
      extraction.category,
      humanWeight,
      suggestedWeight,
    )

    const insertEntityRaw = db.prepare(`
      INSERT INTO entry_entities_raw (id, entry_id, name, type, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const e of extraction.entities) {
      insertEntityRaw.run(
        randomUUID(),
        entryId,
        e.name,
        e.type,
        JSON.stringify({
          kind: e.kind,
          category: e.category,
          status: e.status,
        }),
      )
    }

    createEntityProposalsFromEntry(db, entryId)
    applyManualTagsAsLinks(db, bookmark, entryId, quantomoId)

    db.prepare(
      `UPDATE bookmarks SET
        status = 'PROCESADO_IA',
        category = ?,
        extracted_entities = ?,
        suggested_links = ?,
        quantomo = ?,
        entry_id = ?,
        quantomo_id = ?,
        enrichment_json = ?
       WHERE id = ?`,
    ).run(
      extraction.category,
      JSON.stringify(entitiesForStore),
      JSON.stringify(suggestedLinks),
      extraction.quantomo,
      entryId,
      quantomoId,
      JSON.stringify(enrichment),
      bookmark.id,
    )

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    id: bookmark.id,
    weight: humanWeight,
    category: extraction.category,
    quantomo: extraction.quantomo,
    quantomo_id: quantomoId,
    entry_id: entryId,
    title,
  }
}

export async function processOneBookmark(
  db: DatabaseSync,
  bookmark: Bookmark,
): Promise<ProcessItemResult | null> {
  if (bookmarkSource(bookmark) === 'instagram') {
    return processOneInstagramBookmark(db, bookmark)
  }
  return processOneTwitterBookmark(db, bookmark)
}

export type ReprocessOcrResult = {
  id: string
  ocr_frame_count: number
  video_meta: string | null
  audio_summary: string | null
  title: string
  quantomo: string
  category: string
}

/**
 * Re-corre fotogramas + Vision + extract IG para un bookmark ya PROCESADO_IA
 * con peso ≥ 10. Actualiza ocr_json, enrichment, entry.content_raw y quantomo.
 */
export async function reprocessInstagramOcr(
  bookmarkId: string,
): Promise<ReprocessOcrResult> {
  const db = getDb()
  const bookmark = rows<Bookmark>(
    db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).all(bookmarkId),
  )[0]
  if (!bookmark) throw new Error('Bookmark no encontrado')
  if (bookmarkSource(bookmark) !== 'instagram') {
    throw new Error('Solo aplica a Instagram')
  }
  if (bookmark.status !== 'PROCESADO_IA') {
    throw new Error('Solo bookmarks PROCESADO_IA')
  }
  const weight = bookmark.weight ?? 0
  if (weight < 10) {
    throw new Error('OCR solo para peso 10–12')
  }
  if (!(await hasFfmpeg())) {
    throw new Error(
      'ffmpeg no encontrado. Poné ffmpeg.exe en %USERPROFILE%\\bin o tools\\, o definí FFMPEG_PATH.',
    )
  }

  const media = await ensureReelMedia(bookmark)
  if (!media.ok) {
    throw new Error(`Sin media local: ${media.error}`)
  }

  const framesDir = path.join(instagramVaultDir(bookmark.id), 'frames')
  // Limpiar frames viejos para no mezclar corridas
  try {
    if (fs.existsSync(framesDir)) {
      for (const f of fs.readdirSync(framesDir)) {
        if (/^frame_\d+\.jpg$/i.test(f)) {
          fs.unlinkSync(path.join(framesDir, f))
        }
      }
    }
  } catch {
    /* ignore */
  }

  const frames = await extractFramesEveryNSeconds(media.absPath, framesDir, 3)
  if (frames.length === 0) {
    throw new Error('ffmpeg no extrajo fotogramas')
  }
  const capped = frames.slice(0, 20)
  const analyzed = await analyzeReelFrames(capped)
  const ocrFrames = analyzed.map((f) => ({
    t_sec: f.t_sec,
    explanation: f.explanation,
  }))

  db.prepare(`UPDATE bookmarks SET ocr_json = ?, local_media_path = ? WHERE id = ?`).run(
    JSON.stringify(
      analyzed.map((f) => ({
        t_sec: f.t_sec,
        path: path.relative(process.cwd(), f.path).replace(/\\/g, '/'),
        explanation: f.explanation,
      })),
    ),
    media.relativePath,
    bookmark.id,
  )

  const author = bookmark.author_username
    ? `@${bookmark.author_username}`
    : undefined
  const transcript = bookmark.transcript ?? null

  const extraction = await extractFromInstagramReel({
    description: bookmark.text,
    transcript,
    ocrFrames,
    author,
    link: bookmark.link ?? undefined,
  })
  extraction.entities = dropAuthorEntities(extraction.entities, bookmark)

  const title = clampTitleWords(
    extraction.suggested_title,
    1,
    3,
    'Reel Instagram',
  )

  const contentParts = [bookmark.text]
  if (transcript) contentParts.push(`\n\n--- Transcript ---\n${transcript}`)
  if (extraction.audio_summary) {
    contentParts.push(`\n\n--- Audio summary ---\n${extraction.audio_summary}`)
  }
  if (extraction.video_meta) {
    contentParts.push(`\n\n--- Video meta ---\n${extraction.video_meta}`)
  }
  if (ocrFrames.length > 0) {
    contentParts.push(
      `\n\n--- OCR frames ---\n${ocrFrames
        .map((f) => `[${f.t_sec}s] ${f.explanation}`)
        .join('\n')}`,
    )
  }
  const contentRaw = withOperatorNote(
    contentParts.join(''),
    bookmark.operator_note,
  )

  const enrichment = {
    band: '10-12',
    audio_summary: extraction.audio_summary ?? null,
    video_meta: extraction.video_meta ?? null,
    has_transcript: Boolean(transcript),
    ocr_frame_count: ocrFrames.length,
    reprocessed_ocr_at: new Date().toISOString(),
  }

  const entitiesForStore = extraction.entities.map((e) => ({
    name: e.name,
    type: e.type,
    kind: e.kind ?? null,
  }))
  const suggestedLinks = buildSuggestedLinks(db, extraction.entities)

  const entryId = bookmark.entry_id
  const quantomoId = bookmark.quantomo_id

  db.exec('BEGIN')
  try {
    if (entryId) {
      db.prepare(
        `UPDATE entries SET title = ?, content_raw = ?, vault_path = COALESCE(?, vault_path)
         WHERE id = ?`,
      ).run(title, contentRaw, media.relativePath, entryId)

      // Reemplazar NER raw + propuestas pendientes de este entry
      db.prepare(`DELETE FROM entry_entities_raw WHERE entry_id = ?`).run(entryId)
      db.prepare(
        `DELETE FROM entity_proposals WHERE entry_id = ? AND status = 'pending'`,
      ).run(entryId)

      const insertEntityRaw = db.prepare(`
        INSERT INTO entry_entities_raw (id, entry_id, name, type, payload)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const e of extraction.entities) {
        insertEntityRaw.run(
          randomUUID(),
          entryId,
          e.name,
          e.type,
          JSON.stringify({
            kind: e.kind,
            category: e.category,
            status: e.status,
          }),
        )
      }
      createEntityProposalsFromEntry(db, entryId)
    }

    if (quantomoId) {
      db.prepare(
        `UPDATE quantomos SET title = ?, content = ?, universe = ?, suggested_weight = ?
         WHERE id = ?`,
      ).run(
        title,
        extraction.quantomo,
        extraction.category,
        extraction.suggested_weight,
        quantomoId,
      )
    }

    db.prepare(
      `UPDATE bookmarks SET
        category = ?,
        extracted_entities = ?,
        suggested_links = ?,
        quantomo = ?,
        enrichment_json = ?
       WHERE id = ?`,
    ).run(
      extraction.category,
      JSON.stringify(entitiesForStore),
      JSON.stringify(suggestedLinks),
      extraction.quantomo,
      JSON.stringify(enrichment),
      bookmark.id,
    )

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    id: bookmark.id,
    ocr_frame_count: ocrFrames.length,
    video_meta: extraction.video_meta ?? null,
    audio_summary: extraction.audio_summary ?? null,
    title,
    quantomo: extraction.quantomo,
    category: extraction.category,
  }
}

/** Lista IDs IG PROCESADO_IA w≥10 sin OCR útil (ocr vacío o ocr_frame_count=0). */
export function listOcrReprocessCandidates(limit = 200): string[] {
  const db = getDb()
  return rows<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM bookmarks
         WHERE status = 'PROCESADO_IA'
           AND COALESCE(source, 'twitter') = 'instagram'
           AND weight >= 10
           AND (
             ocr_json IS NULL
             OR ocr_json IN ('', '[]')
             OR enrichment_json LIKE '%"ocr_frame_count":0%'
             OR enrichment_json NOT LIKE '%"ocr_frame_count":%'
           )
         ORDER BY weight DESC, imported_at ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, limit))),
  ).map((r) => r.id)
}

export async function reprocessInstagramOcrBatch(
  ids?: string[],
  limit = 25,
): Promise<{
  processed: number
  skipped: number
  errors: Array<{ id: string; error: string }>
  items: ReprocessOcrResult[]
}> {
  const wanted =
    ids && ids.length > 0
      ? ids
      : listOcrReprocessCandidates(limit)

  const result = {
    processed: 0,
    skipped: 0,
    errors: [] as Array<{ id: string; error: string }>,
    items: [] as ReprocessOcrResult[],
  }

  for (const id of wanted.slice(0, Math.max(1, Math.min(100, limit)))) {
    try {
      const item = await reprocessInstagramOcr(id)
      result.processed += 1
      result.items.push(item)
    } catch (err) {
      result.skipped += 1
      result.errors.push({
        id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

/** IDs elegibles para la cola IA (CRIBADO + reglas IG/Twitter). */
export function listProcessableBookmarkIds(limit = 5000): string[] {
  const db = getDb()
  return rows<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM bookmarks
         WHERE status = 'CRIBADO'
           AND (
             (COALESCE(source, 'twitter') = 'instagram')
             OR (COALESCE(source, 'twitter') <> 'instagram' AND weight >= 7)
           )
         ORDER BY weight DESC, imported_at ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(10000, limit))),
  ).map((r) => r.id)
}

export async function processHighValueBookmarks(
  limit = 25,
): Promise<ProcessHighValueResult> {
  const db = getDb()
  // IG: cualquier CRIBADO (incl. 1–3 → slop). Twitter: solo >= 7.
  const batch = rows<Bookmark>(
    db
      .prepare(
        `SELECT * FROM bookmarks
         WHERE status = 'CRIBADO'
           AND (
             (COALESCE(source, 'twitter') = 'instagram')
             OR (COALESCE(source, 'twitter') <> 'instagram' AND weight >= 7)
           )
         ORDER BY weight DESC, imported_at ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(100, limit))),
  )

  const result: ProcessHighValueResult = {
    processed: 0,
    skipped: 0,
    errors: [],
    ids: [],
    items: [],
  }

  for (const bm of batch) {
    try {
      const item = await processOneBookmark(db, bm)
      result.processed += 1
      result.ids.push(bm.id)
      if (item) result.items.push(item)
    } catch (err) {
      result.errors.push({
        id: bm.id,
        error: err instanceof Error ? err.message : String(err),
      })
      result.skipped += 1
    }
  }

  return result
}

export type BookmarkQuantomoPending = {
  bookmark_id: string
  quantomo_id: string
  entry_id: string
  weight: number | null
  category: string | null
  title: string
  content: string | null
  hermetic_weight: number | null
  human_weight: number | null
  suggested_weight: number | null
  author_username: string | null
  link: string | null
  text: string
}

export function listPendingBookmarkQuantomos(
  limit = 200,
): BookmarkQuantomoPending[] {
  const db = getDb()
  return rows<BookmarkQuantomoPending>(
    db
      .prepare(
        `SELECT
           b.id AS bookmark_id,
           q.id AS quantomo_id,
           b.entry_id AS entry_id,
           b.weight,
           b.category,
           q.title,
           q.content,
           q.hermetic_weight,
           q.human_weight,
           q.suggested_weight,
           b.author_username,
           b.link,
           b.text
         FROM bookmarks b
         JOIN quantomos q ON q.id = b.quantomo_id
         WHERE b.status = 'PROCESADO_IA'
           AND q.recognized = 0
         ORDER BY b.weight DESC, b.imported_at DESC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, limit))),
  )
}

export function approveBookmarkQuantomos(ids?: string[]): {
  approved: number
  entryIds: string[]
} {
  const db = getDb()
  const pending = listPendingBookmarkQuantomos(500)
  const wanted =
    ids && ids.length > 0
      ? pending.filter((p) => ids.includes(p.quantomo_id))
      : pending

  if (wanted.length === 0) return { approved: 0, entryIds: [] }

  const upd = db.prepare(`UPDATE quantomos SET recognized = 1 WHERE id = ?`)
  const entryIds: string[] = []
  db.exec('BEGIN')
  try {
    for (const p of wanted) {
      upd.run(p.quantomo_id)
      if (p.entry_id) entryIds.push(p.entry_id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  for (const entryId of [...new Set(entryIds)]) {
    enqueueEmbed(() => embedApprovedEntry(entryId))
  }

  return { approved: wanted.length, entryIds: [...new Set(entryIds)] }
}
