/**
 * Cola in-memory de procesamiento IA de bookmarks (Criba).
 * Patrón similar a pipeline.ts: start responde al toque; drain corre en background.
 */
import { getDb } from '../db.js'
import { row } from '../sql.js'
import type { Bookmark } from '../types.js'
import {
  listProcessableBookmarkIds,
  processOneBookmark,
} from './bookmarkProcess.js'

export type BookmarkQueueItemResult = {
  id: string
  weight: number
  category: string
  quantomo: string
  quantomo_id: string
  entry_id: string
  title: string
}

export type BookmarkQueueStatus = {
  running: boolean
  stop_requested: boolean
  target: number
  done: number
  remaining: number
  skipped: number
  current_id: string | null
  current_title: string | null
  last_item: BookmarkQueueItemResult | null
  errors: Array<{ id: string; error: string }>
  started_at: string | null
  finished_at: string | null
}

let running = false
let stopRequested = false
let drainGen = 0
let queue: string[] = []
let currentId: string | null = null
let currentTitle: string | null = null
let target = 0
let done = 0
let skipped = 0
let lastItem: BookmarkQueueItemResult | null = null
let errors: Array<{ id: string; error: string }> = []
let startedAt: string | null = null
let finishedAt: string | null = null

function snapshot(): BookmarkQueueStatus {
  return {
    running,
    stop_requested: stopRequested,
    target,
    done,
    remaining: queue.length + (currentId ? 1 : 0),
    skipped,
    current_id: currentId,
    current_title: currentTitle,
    last_item: lastItem,
    errors: errors.slice(-40),
    started_at: startedAt,
    finished_at: finishedAt,
  }
}

export function getBookmarkQueueStatus(): BookmarkQueueStatus {
  return snapshot()
}

/**
 * Encola elegibles CRIBADO y arranca drain si no hay uno activo.
 * Si ya corre, suma IDs nuevos a la cola.
 */
export function startBookmarkProcess(opts?: {
  limit?: number
}): BookmarkQueueStatus & { queued: number; message: string } {
  const limit = Math.max(1, Math.min(10000, opts?.limit ?? 5000))
  const ids = listProcessableBookmarkIds(limit)
  const known = new Set(queue)
  if (currentId) known.add(currentId)
  const fresh = ids.filter((id) => !known.has(id))

  if (fresh.length === 0 && !running) {
    return {
      ...snapshot(),
      queued: 0,
      message: 'Nada listo para procesar',
    }
  }

  for (const id of fresh) queue.push(id)

  if (running) {
    target += fresh.length
    return {
      ...snapshot(),
      queued: fresh.length,
      message: `Sumado a cola activa: +${fresh.length}`,
    }
  }

  target = queue.length
  done = 0
  skipped = 0
  errors = []
  lastItem = null
  currentTitle = null
  stopRequested = false
  startedAt = new Date().toISOString()
  finishedAt = null
  void drain()

  return {
    ...snapshot(),
    queued: queue.length,
    message: `Cola iniciada: ${queue.length}`,
  }
}

export function stopBookmarkProcess(): BookmarkQueueStatus {
  if (!running) return snapshot()
  stopRequested = true
  queue = []
  return snapshot()
}

async function drain(): Promise<void> {
  const gen = ++drainGen
  running = true
  stopRequested = false
  console.log(`[bookmark-queue] drain start gen=${gen} n=${queue.length}`)

  try {
    while (queue.length > 0) {
      if (gen !== drainGen) return
      if (stopRequested) {
        queue = []
        break
      }

      const id = queue.shift()!
      currentId = id
      currentTitle = null

      const db = getDb()
      const bm = row<Bookmark>(
        db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id),
      )
      if (!bm || bm.status !== 'CRIBADO') {
        skipped += 1
        done += 1
        currentId = null
        continue
      }

      currentTitle =
        (bm.text || '').replace(/\s+/g, ' ').trim().slice(0, 80) || id

      try {
        const item = await processOneBookmark(db, bm)
        done += 1
        if (item) {
          lastItem = item
          currentTitle = item.title
        } else {
          // slop u omitido sin quantomo
          lastItem = null
          currentTitle = `slop ${id.slice(0, 8)}`
        }
      } catch (err) {
        skipped += 1
        done += 1
        errors.push({
          id,
          error: err instanceof Error ? err.message : String(err),
        })
        if (errors.length > 80) errors = errors.slice(-80)
        console.error(`[bookmark-queue] ${id}:`, err)
      } finally {
        currentId = null
      }
    }
  } finally {
    if (gen === drainGen) {
      running = false
      stopRequested = false
      currentId = null
      finishedAt = new Date().toISOString()
      console.log(
        `[bookmark-queue] drain end gen=${gen} done=${done} skipped=${skipped}`,
      )
    }
  }
}
