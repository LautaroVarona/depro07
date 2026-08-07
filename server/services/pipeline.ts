import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { getDb } from '../db.js'
import { row, rows } from '../sql.js'
import type { Entry } from '../types.js'
import { transcribeAudio } from './deepgram.js'
import { extractFromTranscript } from './cohere.js'
import {
  FALLBACK_TIMESTAMP,
  resolveOriginAttribution,
} from './originAttribution.js'

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

/**
 * Tras reinicio del server, las entries en `processing` quedan huérfanas
 * (la cola en memoria se pierde). Las devolvemos a `queued`.
 */
export function recoverOrphanedProcessing(): number {
  const db = getDb()
  const result = db
    .prepare(
      `UPDATE entries SET status = 'queued' WHERE status = 'processing'`,
    )
    .run()
  const n = Number(result.changes ?? 0)
  if (n > 0) {
    console.warn(
      `[pipeline] recuperadas ${n} entrada(s) huérfanas processing → queued`,
    )
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
  const result = db
    .prepare(
      `UPDATE entries SET status = 'queued' WHERE status = 'processing'`,
    )
    .run()

  running = false
  currentEntryId = null

  console.log(
    `[pipeline] paused — cleared ${cleared} from memory queue, reset ${result.changes} processing`,
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
    resetProcessing: Number(result.changes ?? 0),
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
              `SELECT id FROM entries WHERE status = 'queued' ORDER BY created_at ASC`,
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
          `SELECT id FROM entries WHERE status = 'queued' ORDER BY created_at ASC`,
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
        await processEntry(id)
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

async function processEntry(entryId: string): Promise<void> {
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
  if (entry.status !== 'queued' && entry.status !== 'processing') {
    console.warn(`[pipeline] skip ${entryId}: status=${entry.status}`)
    return
  }

  db.prepare(`UPDATE entries SET status = 'processing' WHERE id = ?`).run(
    entryId,
  )

  console.log(`[pipeline] start «${entry.title}» (${entryId})`)

  setLiveStage('stt', 'Transcribiendo… (Deepgram)', {
    currentTitle: entry.title,
    transcript: '',
    stub: false,
    chunk: null,
    totalChunks: null,
  })

  if (!entry.vault_path) {
    throw new Error(`Entry ${entryId} has no vault_path`)
  }
  const absPath = path.resolve(process.cwd(), entry.vault_path)
  const { text, stub } = await transcribeAudio(
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
  // Fecha clara (nombre / transcripción / metadata) o fallback 3 mar 2026
  const timestampExact =
    refined.source === 'fallback'
      ? FALLBACK_TIMESTAMP
      : refined.timestampExact

  setLiveStage('extract', 'Extrayendo quántomos…', {
    currentTitle: entry.title,
    transcript: text,
    stub,
  })

  const extraction = await extractFromTranscript(text, entry.title)
  const nextTitle = extraction.suggested_title

  if (shouldAbort(entryId)) {
    console.log(`[pipeline] abort after extract ${entryId}`)
    db.prepare(
      `UPDATE entries SET status = 'queued' WHERE id = ? AND status = 'processing'`,
    ).run(entryId)
    return
  }

  setLiveStage('persist', 'Persistiendo propuestas…', {
    currentTitle: nextTitle,
    transcript: text,
    stub,
  })

  const insertQuantomo = db.prepare(`
    INSERT INTO quantomos (id, entry_id, title, content, hermetic_weight, universe, recognized)
    VALUES (?, ?, ?, ?, ?, ?, 0)
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
    db.prepare(
      `UPDATE entries SET content_raw = ?, timestamp_exact = ?, title = ?, status = 'pending_review' WHERE id = ?`,
    ).run(text, timestampExact, nextTitle, entryId)

    db.prepare(`DELETE FROM entry_entities_raw WHERE entry_id = ?`).run(entryId)

    for (const q of extraction.quantomos) {
      insertQuantomo.run(
        randomUUID(),
        entryId,
        q.title,
        q.content,
        q.hermetic_weight,
        q.universe,
      )
    }
    for (const a of extraction.actions) {
      insertTask.run(randomUUID(), entryId, a.task_text, a.tag)
    }
    for (const e of extraction.entities) {
      const payload = JSON.stringify({
        kind: e.kind,
        category: e.category,
        status: e.status,
        tactical_focus: e.tactical_focus,
      })
      insertEntityRaw.run(randomUUID(), entryId, e.name, e.type, payload)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  setLiveStage('done', `Listo · «${nextTitle}»`, {
    currentTitle: nextTitle,
    transcript: text,
    stub,
  })

  console.log(
    `[pipeline] ${entryId} → pending_review «${nextTitle}» (${extraction.quantomos.length} quantomos, ${extraction.actions.length} tasks, ${extraction.entities.length} entities)`,
  )
}
