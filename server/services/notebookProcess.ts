import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { getDb } from '../db.js'
import type { GraphicElement, NotebookPage } from '../types.js'
import {
  analyzeNotebookPage,
  explainNotebookPage,
  extractNotebookEntities,
  isCohereQuotaError,
} from './cohere.js'
import { getPage, listPages, rebuildNotebookIndex } from './notebookPages.js'
import { createEntityProposalsFromEntry } from './entityMatch.js'
import { embedApprovedEntry, enqueueEmbed } from './embeddings.js'
import {
  applyEntityMentionTags,
  type BlobTag,
} from './blobIngest.js'
import { row } from '../sql.js'

export function parseMentionedEntities(raw: unknown): BlobTag[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  const out: BlobTag[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
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

function normalizePageText(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase()
}

const PLACEHOLDER_TITLES = new Set([
  '',
  'sin título',
  'sin titulo',
  'hoja sin título',
  'hoja sin titulo',
  'tapa',
  'contratapa',
  'página de cuaderno',
  'pagina de cuaderno',
  'sin imagen',
])

const PLACEHOLDER_TRANSCRIPTIONS = new Set([
  '',
  'tapa',
  'contratapa',
])

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return PLACEHOLDER_TITLES.has(normalizePageText(title))
}

function pageHasVisionContent(page: {
  title?: string | null
  transcription_spatial?: string | null
  graphic_elements?: string | null
}): boolean {
  if (page.title?.trim() && !isPlaceholderTitle(page.title)) return true
  const tx = (page.transcription_spatial || '').trim()
  if (tx.length >= 8 && !PLACEHOLDER_TRANSCRIPTIONS.has(tx.toLowerCase())) {
    return true
  }
  try {
    const graphics = JSON.parse(page.graphic_elements || '[]') as unknown
    if (Array.isArray(graphics) && graphics.length > 0) return true
  } catch {
    /* ignore */
  }
  return false
}

export const EXPLANATION_SEPARATOR = '____________________'

export function splitExplanation(
  full: string | null | undefined,
  userStored?: string | null,
): { user: string; ai: string } {
  const storedUser = (userStored || '').trim()
  const text = (full || '').trim()
  if (storedUser) {
    const idx = text.indexOf(EXPLANATION_SEPARATOR)
    if (idx >= 0) {
      return {
        user: storedUser,
        ai: text
          .slice(idx + EXPLANATION_SEPARATOR.length)
          .replace(/^\n+/, '')
          .trim(),
      }
    }
    if (text === storedUser) return { user: storedUser, ai: '' }
    if (text.startsWith(storedUser)) {
      return {
        user: storedUser,
        ai: text.slice(storedUser.length).replace(/^\n+/, '').trim(),
      }
    }
    return { user: storedUser, ai: '' }
  }
  const wrapped = `\n${EXPLANATION_SEPARATOR}\n`
  const idx = text.indexOf(wrapped)
  if (idx >= 0) {
    return {
      user: text.slice(0, idx).trim(),
      ai: text.slice(idx + wrapped.length).trim(),
    }
  }
  const idx2 = text.indexOf(EXPLANATION_SEPARATOR)
  if (idx2 >= 0) {
    return {
      user: text.slice(0, idx2).trim(),
      ai: text
        .slice(idx2 + EXPLANATION_SEPARATOR.length)
        .replace(/^\n+/, '')
        .trim(),
    }
  }
  return { user: '', ai: text }
}

export function composeExplanation(user: string, ai: string): string {
  const u = user.trim()
  const a = ai.trim()
  if (u && a) return `${u}\n${EXPLANATION_SEPARATOR}\n${a}`
  return u || a
}

function pageHasAiExplanation(page: {
  explanation?: string | null
  explanation_user?: string | null
}): boolean {
  return splitExplanation(page.explanation, page.explanation_user).ai.length > 0
}

type VisionJob = { notebookId: string; slotIndex: number }
type ProcessLog = {
  ts: string
  level: 'info' | 'warn' | 'error'
  message: string
  notebook_id?: string
  slot_index?: number
}

const visionQueue: VisionJob[] = []
let visionRunning = false
let visionActive: VisionJob | null = null

const confirmQueue: VisionJob[] = []
let confirmRunning = false
let confirmActive: VisionJob | null = null
const explainQueue: VisionJob[] = []
let explainRunning = false
let explainActive: VisionJob | null = null
const processLogs: ProcessLog[] = []
const MAX_LOGS = 80

function pushLog(
  level: ProcessLog['level'],
  message: string,
  notebookId?: string,
  slotIndex?: number,
): void {
  const line: ProcessLog = {
    ts: new Date().toISOString(),
    level,
    message,
    notebook_id: notebookId,
    slot_index: slotIndex,
  }
  processLogs.push(line)
  if (processLogs.length > MAX_LOGS) processLogs.splice(0, processLogs.length - MAX_LOGS)
  const prefix = `[notebook/${level}]`
  const loc =
    notebookId != null
      ? ` ${notebookId.slice(0, 8)} slot ${slotIndex ?? '—'}`
      : ''
  if (level === 'error') console.error(prefix + loc, message)
  else if (level === 'warn') console.warn(prefix + loc, message)
  else console.log(prefix + loc, message)
}

export function enqueueNotebookVision(
  notebookId: string,
  slotIndex: number,
): void {
  if (
    visionQueue.some(
      (j) => j.notebookId === notebookId && j.slotIndex === slotIndex,
    )
  ) {
    return
  }
  visionQueue.push({ notebookId, slotIndex })
  void drainVisionQueue()
}

export function getNotebookVisionQueueStatus(notebookId?: string): {
  running: boolean
  pending: number
  confirm_running: boolean
  confirm_pending: number
  confirm_jobs: Array<{ notebook_id: string; slot_index: number }>
  current: {
    notebook_id: string
    slot_index: number
    phase: 'vision' | 'explain' | 'confirm'
  } | null
  logs: ProcessLog[]
} {
  const jobs: Array<{ notebook_id: string; slot_index: number }> = []
  if (
    confirmActive &&
    (!notebookId || confirmActive.notebookId === notebookId)
  ) {
    jobs.push({
      notebook_id: confirmActive.notebookId,
      slot_index: confirmActive.slotIndex,
    })
  }
  for (const j of confirmQueue) {
    if (notebookId && j.notebookId !== notebookId) continue
    jobs.push({ notebook_id: j.notebookId, slot_index: j.slotIndex })
  }
  if (
    explainActive &&
    (!notebookId || explainActive.notebookId === notebookId)
  ) {
    jobs.push({
      notebook_id: explainActive.notebookId,
      slot_index: explainActive.slotIndex,
    })
  }
  for (const j of explainQueue) {
    if (notebookId && j.notebookId !== notebookId) continue
    jobs.push({ notebook_id: j.notebookId, slot_index: j.slotIndex })
  }

  let current: {
    notebook_id: string
    slot_index: number
    phase: 'vision' | 'explain' | 'confirm'
  } | null = null
  if (
    visionActive &&
    (!notebookId || visionActive.notebookId === notebookId)
  ) {
    current = {
      notebook_id: visionActive.notebookId,
      slot_index: visionActive.slotIndex,
      phase: 'vision',
    }
  } else if (
    explainActive &&
    (!notebookId || explainActive.notebookId === notebookId)
  ) {
    current = {
      notebook_id: explainActive.notebookId,
      slot_index: explainActive.slotIndex,
      phase: 'explain',
    }
  } else if (
    confirmActive &&
    (!notebookId || confirmActive.notebookId === notebookId)
  ) {
    current = {
      notebook_id: confirmActive.notebookId,
      slot_index: confirmActive.slotIndex,
      phase: 'confirm',
    }
  }

  const pendingForNb = notebookId
    ? visionQueue.filter((j) => j.notebookId === notebookId).length
    : visionQueue.length

  const logs = processLogs
    .filter((l) => !notebookId || l.notebook_id === notebookId)
    .slice(-16)

  return {
    running: visionRunning,
    pending: pendingForNb,
    confirm_running: confirmRunning || explainRunning,
    confirm_pending: jobs.length,
    confirm_jobs: jobs,
    current,
    logs,
  }
}

export function enqueueNotebookConfirm(
  notebookId: string,
  slotIndex: number,
): { queued: boolean; already: boolean } {
  const page = getPage(getDb(), notebookId, slotIndex)
  if (!page) throw new Error('Página no encontrada')
  const hasCurated =
    pageHasVisionContent(page) ||
    Boolean(page.title?.trim() && !isPlaceholderTitle(page.title))
  if (page.is_blank && !hasCurated) {
    throw new Error(
      'Página vacía: agregá título o transcripción, o desmarcá vacía antes de procesar',
    )
  }
  if (!hasCurated) {
    throw new Error('Falta título o transcripción para confirmar')
  }
  if (page.status !== 'Validada' && page.status !== 'Procesada') {
    throw new Error('Aprobá la transcripción antes de enviar al corpus')
  }

  const already =
    (confirmActive?.notebookId === notebookId &&
      confirmActive.slotIndex === slotIndex) ||
    confirmQueue.some(
      (j) => j.notebookId === notebookId && j.slotIndex === slotIndex,
    )
  if (already) return { queued: true, already: true }

  confirmQueue.push({ notebookId, slotIndex })
  void drainConfirmQueue()
  return { queued: true, already: false }
}

async function drainConfirmQueue(): Promise<void> {
  if (confirmRunning) return
  confirmRunning = true
  try {
    while (confirmQueue.length > 0) {
      const job = confirmQueue.shift()!
      confirmActive = job
      try {
        await confirmNotebookPage(job.notebookId, job.slotIndex)
      } catch (err) {
        console.error(
          `[notebook/confirm-queue] ${job.notebookId} slot ${job.slotIndex}:`,
          err,
        )
        pushLog(
          'error',
          `Confirmación: ${err instanceof Error ? err.message : String(err)}`,
          job.notebookId,
          job.slotIndex,
        )
      } finally {
        confirmActive = null
      }
    }
  } finally {
    confirmRunning = false
  }
}

export function enqueueNotebookFullRead(notebookId: string): {
  vision_queued: number
  confirm_queued: number
  skipped: number
} {
  const pages = listPages(getDb(), notebookId)
  let visionQueued = 0
  let skipped = 0

  for (const page of pages) {
    if (!page.image_path) {
      skipped++
      continue
    }
    if (page.status === 'Procesada' || page.status === 'Validada') {
      skipped++
      continue
    }

    enqueueNotebookVision(notebookId, page.slot_index)
    visionQueued++
  }

  pushLog(
    'info',
    `Procesar cuaderno: ${visionQueued} página(s) a transcribir, ${skipped} omitida(s)`,
    notebookId,
  )

  return {
    vision_queued: visionQueued,
    confirm_queued: 0,
    skipped,
  }
}

async function drainVisionQueue(): Promise<void> {
  if (visionRunning) return
  visionRunning = true
  try {
    while (visionQueue.length > 0) {
      const job = visionQueue.shift()!
      visionActive = job
      try {
        await runVisionForPage(job.notebookId, job.slotIndex)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        pushLog('error', msg, job.notebookId, job.slotIndex)
        persistVisionError(job.notebookId, job.slotIndex, msg)
        if (isCohereQuotaError(err)) {
          haltVisionQueue(
            'Cuota de Cohere (Trial / 1000 llamadas). Cambiá a Production key, reiniciá el server y volvé a Procesar cuaderno.',
          )
          break
        }
      } finally {
        visionActive = null
      }
    }
  } finally {
    visionRunning = false
  }
}

function persistVisionError(
  notebookId: string,
  slotIndex: number,
  message: string,
): void {
  const db = getDb()
  const page = getPage(db, notebookId, slotIndex)
  if (!page) return
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(page.vision_meta || '{}') as Record<string, unknown>
  } catch {
    meta = {}
  }
  meta.error = message
  db.prepare(
    `UPDATE pages SET status = 'PendienteVision', vision_meta = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(meta), new Date().toISOString(), page.id)
}

function haltVisionQueue(reason: string): void {
  const dropped = visionQueue.length
  visionQueue.length = 0
  pushLog(
    'error',
    `Cola de visión detenida (${dropped} pendientes canceladas). ${reason}`,
  )
}

async function runVisionForPage(
  notebookId: string,
  slotIndex: number,
): Promise<void> {
  const db = getDb()
  const page = getPage(db, notebookId, slotIndex)
  if (!page?.image_path) {
    pushLog('warn', 'Sin imagen, se omite', notebookId, slotIndex)
    return
  }

  const abs = path.resolve(process.cwd(), page.image_path)
  if (!fs.existsSync(abs)) {
    throw new Error(`Archivo de imagen ausente: ${abs}`)
  }

  pushLog('info', 'Enviando hoja a visión…', notebookId, slotIndex)
  db.prepare(
    `UPDATE pages SET status = 'PendienteVision', updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), page.id)

  const result = await analyzeNotebookPage(abs)
  const now = new Date().toISOString()
  const graphics = JSON.stringify(result.graphic_elements ?? [])
  const visionMeta = JSON.stringify({
    ...(result.meta ?? { layout: 'unknown' }),
    error: null,
  })

  if (
    result.is_blank &&
    page.posicion_visual !== 'Tapa' &&
    page.posicion_visual !== 'ImpactoTapa' &&
    page.posicion_visual !== 'Contratapa'
  ) {
    db.prepare(
      `UPDATE pages SET
        is_blank = 1, status = 'Vacia',
        title = ?, transcription_spatial = ?, graphic_elements = ?,
        vision_meta = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      result.title || null,
      result.transcription_spatial || null,
      graphics,
      visionMeta,
      now,
      page.id,
    )
    pushLog(
      'info',
      `Hoja vacía (${(result.title || '').slice(0, 40) || 'sin título'})`,
      notebookId,
      slotIndex,
    )
  } else {
    let title =
      result.title ||
      (page.posicion_visual === 'Tapa' || page.posicion_visual === 'ImpactoTapa'
        ? 'Tapa'
        : page.posicion_visual === 'Contratapa'
          ? 'Contratapa'
          : 'Sin título')
    let transcription =
      result.transcription_spatial ||
      (page.posicion_visual === 'Tapa' || page.posicion_visual === 'ImpactoTapa'
        ? 'tapa'
        : page.posicion_visual === 'Contratapa'
          ? 'contratapa'
          : '')

    if (result.meta?.layout === 'spread' && result.meta.spread) {
      if (page.posicion_visual === 'Izquierda') {
        if (result.meta.spread.left_title) title = result.meta.spread.left_title
        if (result.meta.spread.left_transcription?.trim()) {
          transcription = result.meta.spread.left_transcription
        }
      } else if (page.posicion_visual === 'Derecha') {
        if (result.meta.spread.right_title) title = result.meta.spread.right_title
        if (result.meta.spread.right_transcription?.trim()) {
          transcription = result.meta.spread.right_transcription
        }
      }
    }

    db.prepare(
      `UPDATE pages SET
        is_blank = 0, status = 'PendienteValidacion',
        title = ?, transcription_spatial = ?, graphic_elements = ?,
        vision_meta = ?, updated_at = ?
       WHERE id = ?`,
    ).run(title, transcription, graphics, visionMeta, now, page.id)
    pushLog(
      'info',
      `Transcripción lista · «${title.slice(0, 48)}» · ${transcription.length} caracteres`,
      notebookId,
      slotIndex,
    )
  }

  rebuildNotebookIndex(db, notebookId)
}

export function approveNotebookTranscription(
  notebookId: string,
  slotIndex: number,
): NotebookPage {
  const db = getDb()
  const page = getPage(db, notebookId, slotIndex)
  if (!page) throw new Error('Página no encontrada')
  const hasCurated =
    pageHasVisionContent(page) ||
    Boolean(page.title?.trim() && !isPlaceholderTitle(page.title))
  if (page.is_blank && !hasCurated) {
    throw new Error(
      'Página vacía: agregá título o transcripción, o desmarcá vacía antes de aprobar',
    )
  }
  if (!hasCurated) {
    throw new Error('Falta título o transcripción para aprobar')
  }
  if (page.status === 'Procesada') return page

  const now = new Date().toISOString()
  db.prepare(
    `UPDATE pages SET status = 'Validada', is_blank = 0, updated_at = ? WHERE id = ?`,
  ).run(now, page.id)
  rebuildNotebookIndex(db, notebookId)
  pushLog('info', 'Transcripción aprobada', notebookId, slotIndex)
  return getPage(db, notebookId, slotIndex)!
}

function parsePageGraphics(page: NotebookPage): GraphicElement[] {
  try {
    return JSON.parse(page.graphic_elements || '[]') as GraphicElement[]
  } catch {
    return []
  }
}

export async function generateExplanationForPage(
  notebookId: string,
  slotIndex: number,
): Promise<NotebookPage> {
  const db = getDb()
  const page = getPage(db, notebookId, slotIndex)
  if (!page) throw new Error('Página no encontrada')
  if (page.status !== 'Validada' && page.status !== 'Procesada') {
    throw new Error('Aprobá la transcripción antes de generar la explicación')
  }

  const graphics = parsePageGraphics(page)
  const user = splitExplanation(page.explanation, page.explanation_user).user
  pushLog('info', 'Generando explicación IA…', notebookId, slotIndex)
  const ai = await explainNotebookPage({
    title: page.title || 'Sin título',
    transcription: page.transcription_spatial || '',
    graphic_elements: graphics,
    posicion: page.posicion_visual,
    numero_logico: page.numero_logico,
  })
  const composed = composeExplanation(user, ai)
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE pages SET explanation = ?, explanation_user = ?, updated_at = ? WHERE id = ?`,
  ).run(composed, user || null, now, page.id)
  rebuildNotebookIndex(db, notebookId)
  pushLog('info', 'Explicación IA lista', notebookId, slotIndex)
  return getPage(db, notebookId, slotIndex)!
}

function jobAlreadyQueued(
  queue: VisionJob[],
  active: VisionJob | null,
  notebookId: string,
  slotIndex: number,
): boolean {
  if (active?.notebookId === notebookId && active.slotIndex === slotIndex) {
    return true
  }
  return queue.some(
    (j) => j.notebookId === notebookId && j.slotIndex === slotIndex,
  )
}

export function enqueueNotebookExplanations(notebookId: string): {
  queued: number
  skipped: number
} {
  const pages = listPages(getDb(), notebookId)
  let queued = 0
  let skipped = 0
  for (const page of pages) {
    if (page.status !== 'Validada') {
      skipped++
      continue
    }
    if (!pageHasVisionContent(page) && !page.title?.trim()) {
      skipped++
      continue
    }
    if (
      jobAlreadyQueued(explainQueue, explainActive, notebookId, page.slot_index)
    ) {
      skipped++
      continue
    }
    explainQueue.push({ notebookId, slotIndex: page.slot_index })
    queued++
  }
  pushLog(
    'info',
    `Explicaciones IA: ${queued} en cola, ${skipped} omitida(s)`,
    notebookId,
  )
  void drainExplainQueue()
  return { queued, skipped }
}

async function drainExplainQueue(): Promise<void> {
  if (explainRunning) return
  explainRunning = true
  try {
    while (explainQueue.length > 0) {
      const job = explainQueue.shift()!
      explainActive = job
      try {
        await generateExplanationForPage(job.notebookId, job.slotIndex)
      } catch (err) {
        pushLog(
          'error',
          `Explicación: ${err instanceof Error ? err.message : String(err)}`,
          job.notebookId,
          job.slotIndex,
        )
      } finally {
        explainActive = null
      }
    }
  } finally {
    explainRunning = false
  }
}

export function enqueueNotebookCorpus(notebookId: string): {
  queued: number
  skipped: number
} {
  const pages = listPages(getDb(), notebookId)
  let queued = 0
  let skipped = 0
  for (const page of pages) {
    if (page.status !== 'Validada') {
      skipped++
      continue
    }
    try {
      const res = enqueueNotebookConfirm(notebookId, page.slot_index)
      if (res.queued) queued++
      else skipped++
    } catch {
      skipped++
    }
  }
  pushLog(
    'info',
    `Envío al corpus: ${queued} en cola, ${skipped} omitida(s)`,
    notebookId,
  )
  return { queued, skipped }
}

export async function confirmNotebookPage(
  notebookId: string,
  slotIndex: number,
): Promise<{
  page: NotebookPage
  entry_id: string
  quantomo_id: string
}> {
  const db = getDb()
  const page = getPage(db, notebookId, slotIndex)
  if (!page) throw new Error('Página no encontrada')

  const hasCurated =
    pageHasVisionContent(page) ||
    Boolean(page.title?.trim() && !isPlaceholderTitle(page.title))

  // is_blank heurístico (tapa lisa, etc.) no bloquea si el operador ya curó contenido
  if (page.is_blank && !hasCurated) {
    throw new Error(
      'Página vacía: agregá título o transcripción, o desmarcá vacía antes de procesar',
    )
  }
  if (!hasCurated) {
    throw new Error('Falta título o transcripción para confirmar')
  }
  if (page.status !== 'Validada' && page.status !== 'Procesada') {
    throw new Error('Aprobá la transcripción antes de enviar al corpus')
  }

  const graphics = parsePageGraphics(page)
  const split = splitExplanation(page.explanation, page.explanation_user)
  let explanation = composeExplanation(split.user, split.ai)
  if (!pageHasAiExplanation({ explanation, explanation_user: split.user })) {
    const ai = await explainNotebookPage({
      title: page.title || 'Sin título',
      transcription: page.transcription_spatial || '',
      graphic_elements: graphics,
      posicion: page.posicion_visual,
      numero_logico: page.numero_logico,
    })
    explanation = composeExplanation(split.user, ai)
  }

  const mentioned = parseMentionedEntities(page.mentioned_entities)
  const entities = await extractNotebookEntities({
    title: page.title || 'Sin título',
    transcription: page.transcription_spatial || '',
    explanation,
    mentioned,
  })

  const contentRaw = [
    page.transcription_spatial || '',
    graphics.length
      ? `\n\n[Elementos gráficos]\n${JSON.stringify(graphics, null, 2)}`
      : '',
    `\n\n[Explicación]\n${explanation}`,
    mentioned.length
      ? `\n\n[Entidades mencionadas]\n${mentioned
          .map((t) => `@${t.entity_name}`)
          .join(', ')}`
      : '',
  ].join('')

  const now = new Date().toISOString()
  const entryId = page.entry_id || randomUUID()
  const quantomoId = page.quantomo_id || randomUUID()
  const title = (page.title || 'Hoja sin título').trim()

  db.exec('BEGIN')
  try {
    if (page.entry_id) {
      db.prepare(
        `UPDATE entries SET title = ?, content_raw = ?, status = 'approved', title_manual = 1
         WHERE id = ?`,
      ).run(title, contentRaw, entryId)
      db.prepare(
        `UPDATE quantomos SET title = ?, content = ?, recognized = 1, universe = 'cuaderno'
         WHERE id = ?`,
      ).run(title, explanation, quantomoId)
      db.prepare(`DELETE FROM entry_entities_raw WHERE entry_id = ?`).run(
        entryId,
      )
      db.prepare(
        `DELETE FROM entity_proposals WHERE entry_id = ? AND status = 'pending'`,
      ).run(entryId)
    } else {
      db.prepare(
        `INSERT INTO entries (
          id, notebook_id, source_type, title, content_raw, vault_path,
          timestamp_exact, status, created_at, title_manual, original_filename
        ) VALUES (?, ?, 'notebook_page', ?, ?, ?, ?, 'approved', ?, 1, ?)`,
      ).run(
        entryId,
        notebookId,
        title,
        contentRaw,
        page.image_path,
        now,
        now,
        page.image_path ? path.basename(page.image_path) : `slot-${slotIndex}`,
      )
      db.prepare(
        `INSERT INTO quantomos (
          id, entry_id, title, content, hermetic_weight, universe, recognized,
          human_weight, suggested_weight
        ) VALUES (?, ?, ?, ?, 7, 'cuaderno', 1, 7, 7)`,
      ).run(quantomoId, entryId, title, explanation)
    }

    const insertEntity = db.prepare(`
      INSERT INTO entry_entities_raw (id, entry_id, name, type, payload)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const e of entities) {
      insertEntity.run(
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
    applyEntityMentionTags(mentioned, entryId, quantomoId, now)

    db.prepare(
      `UPDATE pages SET
        status = 'Procesada', explanation = ?, explanation_user = ?,
        entry_id = ?, quantomo_id = ?,
        is_blank = 0, updated_at = ?
       WHERE id = ?`,
    ).run(
      explanation,
      split.user || null,
      entryId,
      quantomoId,
      now,
      page.id,
    )

    // Tapa actualiza tapa visual, no el nombre que eligió el operador
    if (
      page.posicion_visual === 'Tapa' ||
      page.posicion_visual === 'ImpactoTapa'
    ) {
      db.prepare(
        `UPDATE notebooks SET
          cover_url = COALESCE(?, cover_url),
          updated_at = ?
         WHERE id = ?`,
      ).run(page.image_path, now, notebookId)
    }

    rebuildNotebookIndex(db, notebookId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  enqueueEmbed(() => embedApprovedEntry(entryId))

  const updated = row<NotebookPage>(
    db
      .prepare(
        `SELECT * FROM pages WHERE notebook_id = ? AND slot_index = ?`,
      )
      .get(notebookId, slotIndex),
  )!

  return { page: updated, entry_id: entryId, quantomo_id: quantomoId }
}
