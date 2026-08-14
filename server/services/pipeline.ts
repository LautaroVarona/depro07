import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb, getTrincheraNotebookId } from '../db.js'
import { row, rows } from '../sql.js'
import type { DiarizationPayload, Entry } from '../types.js'
import { transcribeAudio } from './deepgram.js'
import { extractFromTranscript } from './cohere.js'
import {
  FALLBACK_TIMESTAMP,
  resolveOriginAttribution,
} from './originAttribution.js'
import { splitAudioIfLong } from './audioSplit.js'
import {
  applyEntryManualTagsAsLinks,
  applySpeakerLinks,
  findRuidoPersonId,
  maxQuantomosForWeight,
  parseSpeakerMap,
} from './audioCriba.js'
import { parseManualTags } from './bookmarkProcess.js'

let running = false
let paused = false
let queue: string[] = []
/** Entry en curso; al pausar/eliminar se marca para abortar tras la estación actual. */
let currentEntryId: string | null = null
const abortedIds = new Set<string>()
/** Generación del drenado: al forzar unlock se invalida el drain viejo. */
let drainGen = 0
let lastProgressAt = Date.now()

export type PipelineStage =
  | 'idle'
  | 'stt'
  | 'extract'
  | 'persist'
  | 'done'
  | 'paused'

export interface LivePipelineProgress {
  running: boolean
  paused: boolean
  queued: number
  remaining: number
  currentEntryId: string | null
  currentTitle: string | null
  stage: PipelineStage
  stageLabel: string
  transcript: string
  stub: boolean
  chunk: number | null
  totalChunks: number | null
}

let live: LivePipelineProgress = {
  running: false,
  paused: false,
  queued: 0,
  remaining: 0,
  currentEntryId: null,
  currentTitle: null,
  stage: 'idle',
  stageLabel: 'En espera',
  transcript: '',
  stub: false,
  chunk: null,
  totalChunks: null,
}

function syncLiveCounts(): void {
  live.running = running
  live.paused = paused
  live.queued = queue.length
  live.remaining = queue.length + (currentEntryId ? 1 : 0)
  live.currentEntryId = currentEntryId
}

function setLiveStage(
  stage: PipelineStage,
  stageLabel: string,
  patch?: Partial<LivePipelineProgress>,
): void {
  lastProgressAt = Date.now()
  live = {
    ...live,
    stage,
    stageLabel,
    ...patch,
  }
  syncLiveCounts()
}

export function isPipelineRunning(): boolean {
  return running
}

export function isPipelinePaused(): boolean {
  return paused
}

export function getPipelineStatus(): LivePipelineProgress {
  syncLiveCounts()
  return { ...live }
}

function recoverProcessingRow(database: ReturnType<typeof getDb>): number {
  const stuck = rows<{
    id: string
    content_raw: string | null
    human_weight: number | null
  }>(
    database
      .prepare(
        `SELECT id, content_raw, human_weight FROM entries WHERE status = 'processing'`,
      )
      .all(),
  )
  let n = 0
  const upd = database.prepare(`UPDATE entries SET status = ? WHERE id = ?`)
  for (const e of stuck) {
    const next =
      e.human_weight != null
        ? 'pending_extract'
        : e.content_raw && e.content_raw.trim()
          ? 'pending_criba'
          : 'queued'
    upd.run(next, e.id)
    n++
  }
  return n
}

/**
 * Tras reinicio del server, las entries en `processing` quedan huérfanas
 * (la cola en memoria se pierde). Las devolvemos según la fase.
 */
export function recoverOrphanedProcessing(): number {
  const n = recoverProcessingRow(getDb())
  if (n > 0) {
    console.warn(`[pipeline] recuperadas ${n} entrada(s) huérfanas processing`)
  }
  return n
}

/** Invalida el drain actual y libera el flag running. */
function forceUnlockPipeline(reason: string): void {
  console.warn(`[pipeline] force unlock: ${reason}`)
  drainGen += 1
  if (currentEntryId) abortedIds.add(currentEntryId)
  currentEntryId = null
  running = false
  recoverOrphanedProcessing()
}

/** Quita un id de la cola en memoria (p.ej. al eliminar una carga). */
export function removeFromPipelineQueue(entryId: string): void {
  queue = queue.filter((id) => id !== entryId)
  if (currentEntryId === entryId) {
    abortedIds.add(entryId)
  }
}

export function pausePipeline(): {
  paused: boolean
  cleared: number
  resetProcessing: number
} {
  paused = true
  const cleared = queue.length
  queue = []

  if (currentEntryId) {
    abortedIds.add(currentEntryId)
  }
  drainGen += 1

  const db = getDb()
  const resetN = recoverProcessingRow(db)

  running = false
  currentEntryId = null

  console.log(
    `[pipeline] paused — cleared ${cleared} from memory queue, reset ${resetN} processing`,
  )

  setLiveStage('paused', 'Pausado', {
    currentTitle: null,
    transcript: '',
    stub: false,
    chunk: null,
    totalChunks: null,
  })

  return {
    paused: true,
    cleared,
    resetProcessing: resetN,
  }
}

export function resumePipeline(): { paused: boolean } {
  paused = false
  console.log('[pipeline] resumed')
  setLiveStage('idle', 'Listo para procesar')
  return { paused: false }
}

export async function enqueuePipeline(entryIds?: string[]): Promise<{
  accepted: string[]
  message: string
}> {
  if (paused) {
    paused = false
    console.log('[pipeline] auto-resume on run')
  }

  const stuckMs = Date.now() - lastProgressAt
  const STUCK_MS = Number(process.env.PIPELINE_STUCK_MS || 120000) || 120000

  if (running) {
    if (!currentEntryId || stuckMs > STUCK_MS) {
      forceUnlockPipeline(
        !currentEntryId
          ? 'running sin currentEntry'
          : `sin progreso ${Math.round(stuckMs / 1000)}s`,
      )
    } else {
      // Drain sano en curso: solo sumar a la cola
      const db = getDb()
      let ids = entryIds
      if (!ids || ids.length === 0) {
        const found = rows<{ id: string }>(
          db
            .prepare(
              `SELECT id FROM entries WHERE status IN ('queued', 'pending_extract') ORDER BY created_at ASC`,
            )
            .all(),
        )
        ids = found.map((r) => r.id)
      }
      for (const id of ids) {
        abortedIds.delete(id)
        if (!queue.includes(id)) queue.push(id)
      }
      syncLiveCounts()
      console.log(
        `[pipeline] drain activo — +${ids.length} en cola (mem ${queue.length})`,
      )
      return {
        accepted: ids,
        message: `Sumado a cola activa: ${ids.length} · pendientes ${queue.length + 1}`,
      }
    }
  }

  const recovered = recoverOrphanedProcessing()
  const db = getDb()
  let ids = entryIds

  if (!ids || ids.length === 0) {
    const found = rows<{ id: string }>(
      db
        .prepare(
          `SELECT id FROM entries WHERE status IN ('queued', 'pending_extract') ORDER BY created_at ASC`,
        )
        .all(),
    )
    ids = found.map((r) => r.id)
  }

  if (ids.length === 0) {
    return {
      accepted: [],
      message:
        recovered > 0
          ? `Recuperadas ${recovered} huérfanas; no hay entradas en cola`
          : 'No hay entradas en cola',
    }
  }

  queue = []
  for (const id of ids) {
    abortedIds.delete(id)
    queue.push(id)
  }

  setLiveStage('idle', `Iniciando cola · ${ids.length} entrada(s)`)
  console.log(`[pipeline] enqueue ${ids.length} → drain`)

  void drainQueue()
  return {
    accepted: ids,
    message: `Pipeline encolado: ${ids.length} entrada(s)${
      recovered > 0 ? ` · recuperadas ${recovered} huérfanas` : ''
    }`,
  }
}

function shouldAbort(entryId: string): boolean {
  return paused || abortedIds.has(entryId)
}

async function drainQueue(): Promise<void> {
  if (running) {
    console.warn('[pipeline] drainQueue skipped — already running')
    return
  }
  const gen = ++drainGen
  running = true
  syncLiveCounts()
  console.log(`[pipeline] drain start gen=${gen} queue=${queue.length}`)

  try {
    while (queue.length > 0) {
      if (gen !== drainGen) {
        console.warn(`[pipeline] drain gen=${gen} superseded`)
        return
      }
      if (paused) {
        queue = []
        break
      }
      const id = queue.shift()!
      if (abortedIds.has(id)) {
        abortedIds.delete(id)
        continue
      }
      currentEntryId = id
      syncLiveCounts()
      try {
        const extra = await processEntry(id)
        if (extra?.length) {
          for (const childId of extra) {
            abortedIds.delete(childId)
            if (!queue.includes(childId)) queue.push(childId)
          }
        }
      } catch (err) {
        console.error(`[pipeline] entry ${id} failed:`, err)
        if (!abortedIds.has(id)) {
          getDb()
            .prepare(
              `UPDATE entries SET status = 'queued' WHERE id = ? AND status = 'processing'`,
            )
            .run(id)
        }
      } finally {
        if (currentEntryId === id) currentEntryId = null
        abortedIds.delete(id)
        syncLiveCounts()
      }
    }
  } finally {
    if (gen === drainGen) {
      running = false
      if (paused) {
        setLiveStage('paused', 'Pausado', {
          currentTitle: null,
        })
      } else {
        setLiveStage('idle', 'En espera', {
          currentTitle: null,
          transcript: '',
          stub: false,
          chunk: null,
          totalChunks: null,
        })
      }
      console.log(`[pipeline] drain end gen=${gen}`)
    }
  }
}

async function processEntry(entryId: string): Promise<string[] | void> {
  if (shouldAbort(entryId)) {
    console.log(`[pipeline] abort before start ${entryId}`)
    return
  }

  const db = getDb()
  const entry = row<Entry>(
    db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId),
  )

  if (!entry) {
    console.warn(`[pipeline] entry not found: ${entryId}`)
    return
  }

  const phaseB =
    entry.status === 'pending_extract' ||
    (entry.status === 'processing' && entry.human_weight != null) ||
    (entry.status === 'queued' && entry.human_weight != null)

  if (
    entry.status !== 'queued' &&
    entry.status !== 'processing' &&
    entry.status !== 'pending_extract'
  ) {
    console.warn(`[pipeline] skip ${entryId}: status=${entry.status}`)
    return
  }

  db.prepare(`UPDATE entries SET status = 'processing' WHERE id = ?`).run(
    entryId,
  )

  if (phaseB) {
    await extractAfterVote(entry)
    return
  }

  return transcribeForCriba(entry)
}

async function transcribeForCriba(entry: Entry): Promise<string[] | void> {
  const entryId = entry.id
  const db = getDb()
  console.log(`[pipeline] fase A STT «${entry.title}» (${entryId})`)

  if (!entry.vault_path) {
    throw new Error(`Entry ${entryId} has no vault_path`)
  }
  const absPath = path.resolve(process.cwd(), entry.vault_path)

  if (!entry.parent_entry_id) {
    const partsDir = path.join(path.dirname(absPath), 'parts')
    const split = await splitAudioIfLong(absPath, partsDir)
    if (split.durationSec != null) {
      db.prepare(`UPDATE entries SET duration_sec = ? WHERE id = ?`).run(
        split.durationSec,
        entryId,
      )
    }
    if (split.parts.length >= 2) {
      const childIds = spawnSplitChildren(entry, split.parts, split.durationSec)
      db.prepare(
        `UPDATE entries SET status = 'split_parent', duration_sec = ? WHERE id = ?`,
      ).run(split.durationSec, entryId)
      console.log(
        `[pipeline] ${entryId} → split_parent (${childIds.length} partes)`,
      )
      return childIds
    }
  }

  setLiveStage('stt', 'Transcribiendo… (Deepgram)', {
    currentTitle: entry.title,
    transcript: '',
    stub: false,
    chunk: null,
    totalChunks: null,
  })

  const { text, stub, utterances } = await transcribeAudio(
    absPath,
    entry.title,
    (partial, meta) => {
      if (shouldAbort(entryId)) return
      setLiveStage(
        'stt',
        `Transcribiendo… chunk ${meta.chunk}/${meta.total}`,
        {
          currentTitle: entry.title,
          transcript: partial || live.transcript,
          stub: false,
          chunk: meta.chunk,
          totalChunks: meta.total,
        },
      )
    },
    () => shouldAbort(entryId),
  )
  if (stub) {
    console.warn(
      `[pipeline] ${entryId}: STT stub (Deepgram falló o archivo inválido)`,
    )
  }

  setLiveStage('stt', stub ? 'STT stub listo' : 'Transcripción lista', {
    currentTitle: entry.title,
    transcript: text,
    stub,
    chunk: live.totalChunks,
    totalChunks: live.totalChunks,
  })

  if (shouldAbort(entryId)) {
    console.log(`[pipeline] abort after STT ${entryId}`)
    db.prepare(
      `UPDATE entries SET status = 'queued' WHERE id = ? AND status = 'processing'`,
    ).run(entryId)
    return
  }

  const vaultFilename =
    entry.original_filename ||
    (entry.vault_path ? path.basename(entry.vault_path) : null) ||
    `${entry.title}.m4a`
  const refined = resolveOriginAttribution({
    filename: vaultFilename,
    transcript: text,
    defaultYear: 2026,
  })
  const timestampExact =
    refined.source === 'fallback'
      ? FALLBACK_TIMESTAMP
      : refined.timestampExact

  const speakers = [...new Set(utterances.map((u) => u.speaker))].sort(
    (a, b) => a - b,
  )
  if (speakers.length === 0) speakers.push(0)
  const payload: DiarizationPayload = { utterances, speakers }
  const personTags = parseManualTags(entry.manual_tags).filter(
    (t) => t.kind === 'person',
  )
  const speakerMap = speakers.map((speaker, i) => {
    const tag = personTags.length === 1 && speaker === 0 ? personTags[0] : personTags[i]
    return {
      speaker,
      person_id: tag?.entity_id ?? null,
      person_name: tag?.entity_name ?? null,
    }
  })

  db.prepare(
    `UPDATE entries SET
       content_raw = ?, timestamp_exact = ?, status = 'pending_criba',
       diarization_json = ?, speaker_map = ?
     WHERE id = ?`,
  ).run(
    text,
    timestampExact,
    JSON.stringify(payload),
    JSON.stringify(speakerMap),
    entryId,
  )

  setLiveStage('done', `Listo para criba · «${entry.title}»`, {
    currentTitle: entry.title,
    transcript: text,
    stub,
  })
  console.log(
    `[pipeline] ${entryId} → pending_criba (${text.length} chars, ${speakers.length} voces)`,
  )
}

function spawnSplitChildren(
  parent: Entry,
  partAbsPaths: string[],
  durationSec: number | null,
): string[] {
  const db = getDb()
  const notebookId = parent.notebook_id || getTrincheraNotebookId()
  const now = new Date().toISOString()
  const ids: string[] = []
  const insert = db.prepare(`
    INSERT INTO entries (
      id, notebook_id, source_type, title, content_raw,
      vault_path, timestamp_exact, status, created_at, title_manual,
      original_filename, batch_id, parent_entry_id, manual_tags,
      operator_note, human_weight, speaker_map
    ) VALUES (?, ?, 'audio', ?, NULL, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, NULL, '[]')
  `)

  for (let i = 0; i < partAbsPaths.length; i++) {
    const abs = partAbsPaths[i]!
    const childId = randomUUID()
    const dir = path.resolve(process.cwd(), 'vault', childId)
    fs.mkdirSync(dir, { recursive: true })
    const destName = path.basename(abs)
    const dest = path.join(dir, destName)
    fs.renameSync(abs, dest)
    const vaultPath = path
      .relative(process.cwd(), dest)
      .split(path.sep)
      .join('/')
    const title = `${parent.title} · parte ${i + 1}`
    const original = parent.original_filename
      ? `${parent.original_filename} · parte ${i + 1}`
      : destName
    insert.run(
      childId,
      notebookId,
      title,
      vaultPath,
      parent.timestamp_exact,
      now,
      original,
      parent.batch_id,
      parent.id,
      parent.manual_tags ?? '[]',
      parent.operator_note ?? '',
    )
    ids.push(childId)
  }
  void durationSec
  return ids
}

async function extractAfterVote(entry: Entry): Promise<void> {
  const entryId = entry.id
  const db = getDb()
  const text = (entry.content_raw ?? '').trim()
  const weight = Math.max(1, Math.min(12, Number(entry.human_weight ?? 7)))
  const slop = weight <= 3
  const maxQ = maxQuantomosForWeight(weight)

  console.log(
    `[pipeline] fase B extract «${entry.title}» w=${weight} maxQ=${maxQ}${slop ? ' SLOP' : ''}`,
  )

  setLiveStage('extract', 'Extrayendo quántomos…', {
    currentTitle: entry.title,
    transcript: text,
    stub: false,
  })

  const speakerLines = parseSpeakerMap(entry.speaker_map)
    .filter((s) => s.person_name)
    .map((s) => `Speaker ${s.speaker} = ${s.person_name}`)
  const tags = parseManualTags(entry.manual_tags)
  const tagsContext =
    tags.length > 0
      ? `Tags del lote: ${tags.map((t) => `@${t.entity_name} (${t.kind})`).join(', ')}`
      : ''

  const extraction = await extractFromTranscript(text, entry.title, {
    fallback: 'none',
    maxQuantomos: maxQ,
    humanWeight: weight,
    slop,
    speakerContext:
      speakerLines.length > 0
        ? `Identidad de voces:\n${speakerLines.join('\n')}`
        : '',
    tagsContext,
    operatorNote: entry.operator_note ?? '',
  })
  const nextTitle =
    entry.title_manual === 1 ? entry.title : extraction.suggested_title

  if (shouldAbort(entryId)) {
    console.log(`[pipeline] abort after extract ${entryId}`)
    db.prepare(
      `UPDATE entries SET status = 'pending_extract' WHERE id = ? AND status = 'processing'`,
    ).run(entryId)
    return
  }

  setLiveStage('persist', 'Persistiendo propuestas…', {
    currentTitle: nextTitle,
    transcript: text,
  })

  const ruido = slop ? findRuidoPersonId(db) : null
  const insertQuantomo = db.prepare(`
    INSERT INTO quantomos (
      id, entry_id, title, content, hermetic_weight, universe, recognized,
      suggested_weight, human_weight
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `)
  const insertTask = db.prepare(`
    INSERT INTO pending_tasks (id, entry_id, task_text, tag, status)
    VALUES (?, ?, ?, ?, 'suggested')
  `)
  const insertEntityRaw = db.prepare(`
    INSERT INTO entry_entities_raw (id, entry_id, name, type, payload)
    VALUES (?, ?, ?, ?, ?)
  `)

  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM quantomos WHERE entry_id = ? AND recognized = 0`).run(
      entryId,
    )
    db.prepare(`DELETE FROM pending_tasks WHERE entry_id = ?`).run(entryId)
    db.prepare(`DELETE FROM entry_entities_raw WHERE entry_id = ?`).run(entryId)

    db.prepare(
      `UPDATE entries SET title = ?, status = 'pending_review' WHERE id = ?`,
    ).run(nextTitle, entryId)

    let firstQuantomoId: string | null = null
    for (const q of extraction.quantomos) {
      const qid = randomUUID()
      if (!firstQuantomoId) firstQuantomoId = qid
      insertQuantomo.run(
        qid,
        entryId,
        q.title,
        q.content,
        weight,
        q.universe,
        weight,
        weight,
      )
    }
    for (const a of extraction.actions) {
      insertTask.run(randomUUID(), entryId, a.task_text, a.tag)
    }
    for (const e of extraction.entities) {
      const payload = JSON.stringify({
        kind: slop && e.type === 'person' ? 'ruido' : e.kind,
        category: e.category,
        status: e.status,
        tactical_focus: e.tactical_focus,
        ...(slop && e.type === 'person' && ruido
          ? {
              discard_hint: 'ruido',
              suggested_match_id: ruido.id,
              suggested_match_name: ruido.name,
            }
          : slop && e.type === 'person'
            ? { discard_hint: 'ruido' }
            : {}),
      })
      insertEntityRaw.run(randomUUID(), entryId, e.name, e.type, payload)
    }

    applyEntryManualTagsAsLinks(
      db,
      entry.manual_tags,
      entryId,
      firstQuantomoId,
    )
    applySpeakerLinks(db, entry.speaker_map, entryId, firstQuantomoId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  setLiveStage('done', `Listo · «${nextTitle}»`, {
    currentTitle: nextTitle,
    transcript: text,
  })
  console.log(
    `[pipeline] ${entryId} → pending_review «${nextTitle}» (${extraction.quantomos.length} quantomos, ${extraction.actions.length} tasks, ${extraction.entities.length} entities)`,
  )
}
