/**
 * Agrupación cronológica de mensajes en bloques (jornada o gap > 4h).
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { rows } from '../sql.js'
import type { ChatMessage } from '../types.js'

const GAP_MS = 4 * 60 * 60 * 1000

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function toMs(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

export type BlockPlan = {
  id: string
  started_at: string
  ended_at: string
  day_key: string
  message_ids: string[]
}

export function planBlocksFromMessages(
  messages: Array<Pick<ChatMessage, 'id' | 'timestamp_exact' | 'is_system'>>,
): BlockPlan[] {
  const content = [...messages]
    .filter((m) => !m.is_system)
    .sort((a, b) => {
      const c = a.timestamp_exact.localeCompare(b.timestamp_exact)
      return c !== 0 ? c : a.id.localeCompare(b.id)
    })

  if (content.length === 0) return []

  const blocks: BlockPlan[] = []
  let cur: BlockPlan | null = null
  let lastMs = 0

  for (const m of content) {
    const ms = toMs(m.timestamp_exact)
    const dk = dayKey(m.timestamp_exact)
    const shouldSplit =
      !cur ||
      dk !== cur.day_key ||
      (lastMs > 0 && ms - lastMs > GAP_MS)

    if (shouldSplit) {
      if (cur) blocks.push(cur)
      cur = {
        id: randomUUID(),
        started_at: m.timestamp_exact,
        ended_at: m.timestamp_exact,
        day_key: dk,
        message_ids: [m.id],
      }
    } else if (cur) {
      cur.message_ids.push(m.id)
      cur.ended_at = m.timestamp_exact
    }
    lastMs = ms
  }
  if (cur) blocks.push(cur)
  return blocks
}

/** Persiste bloques y asigna block_id a mensajes de contenido. */
export function createBlocksForSession(
  db: DatabaseSync,
  sessionId: string,
): number {
  const messages = rows<ChatMessage>(
    db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE chat_session_id = ?
         ORDER BY timestamp_exact ASC, sort_index ASC`,
      )
      .all(sessionId),
  )

  // Clear previous blocks if re-running
  db.prepare(`DELETE FROM chat_blocks WHERE chat_session_id = ?`).run(sessionId)
  db.prepare(
    `UPDATE chat_messages SET block_id = NULL WHERE chat_session_id = ?`,
  ).run(sessionId)

  const plans = planBlocksFromMessages(messages)
  const insertBlock = db.prepare(
    `INSERT INTO chat_blocks (
      id, chat_session_id, started_at, ended_at, day_key,
      message_count, estado, entry_id, quantomo_id, summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, 'pendiente', NULL, NULL, '{}')`,
  )
  const updMsg = db.prepare(
    `UPDATE chat_messages SET block_id = ? WHERE id = ?`,
  )

  for (const p of plans) {
    insertBlock.run(
      p.id,
      sessionId,
      p.started_at,
      p.ended_at,
      p.day_key,
      p.message_ids.length,
    )
    for (const mid of p.message_ids) {
      updMsg.run(p.id, mid)
    }
  }
  return plans.length
}
