/**
 * Import + procesamiento de sesiones de chat → entries/quantomos/proposals.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { getDb, getTrincheraNotebookId } from '../db.js'
import { row, rows } from '../sql.js'
import type {
  ChatBlock,
  ChatMessage,
  ChatSession,
  ChatTipo,
} from '../types.js'
import { createBlocksForSession } from './chatBlocks.js'
import { parseWhatsAppExport, type ParsedChat } from './chatParse.js'
import { extractFromChatBlock } from './cohere.js'
import { createEntityProposalsFromEntry } from './entityMatch.js'
import { insertLinkHarvest } from './linkHarvest.js'
import { clampTitleWords } from './titleUtils.js'

const processingSessions = new Set<string>()

function vaultChatDir(sessionId: string): string {
  return path.resolve(process.cwd(), 'vault', 'chats', sessionId)
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const p = JSON.parse(raw) as unknown
    if (Array.isArray(p)) return p.map(String).filter(Boolean)
  } catch {
    /* ignore */
  }
  return []
}

export function previewChatFile(
  buffer: Buffer,
  filename: string,
): ReturnType<typeof parseWhatsAppExport> {
  return parseWhatsAppExport(buffer.toString('utf8'), { filename })
}

export type ImportChatResult = {
  session: ChatSession
  message_count: number
  block_count: number
  link_count: number
}

export function importChatSession(input: {
  buffer: Buffer
  filename: string
  nombre_chat?: string
  tipo?: ChatTipo
  person_ids?: string[]
}): ImportChatResult {
  const db = getDb()
  const parsed = parseWhatsAppExport(input.buffer.toString('utf8'), {
    filename: input.filename,
  })

  const existing = row<ChatSession>(
    db
      .prepare(`SELECT * FROM chat_sessions WHERE origin_hash = ?`)
      .get(parsed.origin_hash),
  )
  if (existing) {
    const err = new Error(`Chat ya importado: ${existing.nombre_chat}`) as Error & {
      status?: number
      session?: ChatSession
    }
    err.status = 409
    err.session = existing
    throw err
  }

  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const tipo: ChatTipo = input.tipo ?? parsed.tipo_auto
  const nombre = (input.nombre_chat || parsed.suggested_name).trim()
  const personIds = (input.person_ids ?? []).filter(Boolean)

  const dir = vaultChatDir(sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const vaultPath = path.join(dir, 'export.txt')
  fs.writeFileSync(vaultPath, input.buffer)

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO chat_sessions (
        id, origin_hash, nombre_chat, tipo, participantes_json,
        linked_person_ids_json, vault_path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'parsed', ?, ?)`,
    ).run(
      sessionId,
      parsed.origin_hash,
      nombre,
      tipo,
      JSON.stringify(parsed.participantes),
      JSON.stringify(personIds),
      vaultPath,
      now,
      now,
    )

    const insertMsg = db.prepare(
      `INSERT INTO chat_messages (
        id, chat_session_id, remitente, texto_crudo, timestamp_exact,
        is_system, is_media, estado_procesamiento, block_id, sort_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', NULL, ?)`,
    )

    let link_count = 0
    for (const m of parsed.messages) {
      insertMsg.run(
        m.id,
        sessionId,
        m.remitente,
        m.texto_crudo,
        m.timestamp_exact,
        m.is_system ? 1 : 0,
        m.is_media ? 1 : 0,
        m.sort_index,
      )
      for (const url of m.urls) {
        if (
          insertLinkHarvest(db, {
            url_cruda: url,
            source_type: 'chat_message',
            source_id: m.id,
            remitente: m.remitente,
            timestamp_captura: m.timestamp_exact,
            chat_session_id: sessionId,
          })
        ) {
          link_count++
        }
      }
    }

    const block_count = createBlocksForSession(db, sessionId)
    db.exec('COMMIT')

    const session = row<ChatSession>(
      db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(sessionId),
    )!
    return {
      session,
      message_count: parsed.messages.length,
      block_count,
      link_count,
    }
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}

function buildBlockTranscript(
  messages: ChatMessage[],
): string {
  return messages
    .map((m) => {
      const who = m.remitente || 'Sistema'
      const media = m.is_media ? ' [multimedia]' : ''
      return `[${m.timestamp_exact}] ${who}: ${m.texto_crudo}${media}`
    })
    .join('\n')
}

export type ProcessChatResult = {
  processed: number
  skipped: number
  remaining: number
  errors: Array<{ block_id: string; error: string }>
  items: Array<{
    block_id: string
    entry_id: string
    quantomo_id: string
    title: string
  }>
}

export async function processChatSession(
  sessionId: string,
  opts?: { limit?: number },
): Promise<ProcessChatResult> {
  if (processingSessions.has(sessionId)) {
    throw new Error('Esta sesión ya se está procesando')
  }
  processingSessions.add(sessionId)
  try {
    return await processChatSessionInner(sessionId, opts)
  } finally {
    processingSessions.delete(sessionId)
  }
}

async function processChatSessionInner(
  sessionId: string,
  opts?: { limit?: number },
): Promise<ProcessChatResult> {
  const db = getDb()
  const session = row<ChatSession>(
    db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(sessionId),
  )
  if (!session) throw new Error('Sesión no encontrada')

  const limit = Math.max(1, Math.min(opts?.limit ?? 5, 50))
  const blocks = rows<ChatBlock>(
    db
      .prepare(
        `SELECT * FROM chat_blocks
         WHERE chat_session_id = ? AND estado = 'pendiente'
         ORDER BY started_at ASC
         LIMIT ?`,
      )
      .all(sessionId, limit),
  )

  const result: ProcessChatResult = {
    processed: 0,
    skipped: 0,
    remaining: 0,
    errors: [],
    items: [],
  }

  if (blocks.length === 0) {
    const pending = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM chat_blocks
             WHERE chat_session_id = ? AND estado = 'pendiente'`,
          )
          .get(sessionId) as { n: number | bigint }
      ).n ?? 0,
    )
    result.remaining = pending
    if (pending === 0) {
      db.prepare(
        `UPDATE chat_sessions SET status = 'processed', updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), sessionId)
    }
    return result
  }

  db.prepare(
    `UPDATE chat_sessions SET status = 'processing', updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), sessionId)

  const participantes = parseJsonArray(session.participantes_json)
  const linkedPersonIds = parseJsonArray(session.linked_person_ids_json)
  const notebookId = getTrincheraNotebookId()

  for (const block of blocks) {
    try {
      const item = await processOneBlock(db, {
        session,
        block,
        participantes,
        linkedPersonIds,
        notebookId,
      })
      result.processed++
      result.items.push(item)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push({ block_id: block.id, error: msg })
      db.prepare(
        `UPDATE chat_blocks SET estado = 'error', summary_json = ? WHERE id = ?`,
      ).run(JSON.stringify({ error: msg }), block.id)
    }
  }

  const remaining = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM chat_blocks
           WHERE chat_session_id = ? AND estado = 'pendiente'`,
        )
        .get(sessionId) as { n: number | bigint }
    ).n ?? 0,
  )
  result.remaining = remaining
  const status = remaining === 0 ? 'processed' : 'processing'
  db.prepare(
    `UPDATE chat_sessions SET status = ?, updated_at = ? WHERE id = ?`,
  ).run(status, new Date().toISOString(), sessionId)

  return result
}

async function processOneBlock(
  db: DatabaseSync,
  ctx: {
    session: ChatSession
    block: ChatBlock
    participantes: string[]
    linkedPersonIds: string[]
    notebookId: string
  },
): Promise<{
  block_id: string
  entry_id: string
  quantomo_id: string
  title: string
}> {
  const { session, block, participantes, linkedPersonIds, notebookId } = ctx
  const messages = rows<ChatMessage>(
    db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE block_id = ?
         ORDER BY timestamp_exact ASC, sort_index ASC`,
      )
      .all(block.id),
  )
  if (messages.length === 0) {
    throw new Error('bloque sin mensajes')
  }

  const transcript = buildBlockTranscript(messages)
  const extraction = await extractFromChatBlock({
    chatName: session.nombre_chat,
    tipo: session.tipo,
    participantes,
    transcript,
    dayKey: block.day_key,
  })

  const entryId = randomUUID()
  const quantomoId = randomUUID()
  const now = new Date().toISOString()
  const title = clampTitleWords(
    extraction.title,
    3,
    5,
    `${session.nombre_chat} ${block.day_key}`,
  )
  const weight = extraction.suggested_weight ?? 7

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO entries (
        id, notebook_id, source_type, title, content_raw, vault_path,
        timestamp_exact, status, created_at, title_manual, original_filename
      ) VALUES (?, ?, 'chat', ?, ?, ?, ?, 'approved', ?, 1, ?)`,
    ).run(
      entryId,
      notebookId,
      title,
      transcript,
      session.vault_path,
      block.started_at,
      now,
      `chat:${session.id}:${block.id}`,
    )

    db.prepare(
      `INSERT INTO quantomos (
        id, entry_id, title, content, hermetic_weight, universe, recognized,
        human_weight, suggested_weight
      ) VALUES (?, ?, ?, ?, ?, 'chat', 1, ?, ?)`,
    ).run(
      quantomoId,
      entryId,
      title,
      extraction.quantomo,
      weight,
      weight,
      weight,
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
          locations: extraction.locations,
          milestones: extraction.milestones,
        }),
      )
    }

    createEntityProposalsFromEntry(db, entryId)

    const insertLink = db.prepare(`
      INSERT INTO entity_links (
        id, entity_kind, entity_id, entry_id, quantomo_id, role, created_at
      ) VALUES (?, 'person', ?, ?, ?, 'participant', ?)
    `)
    for (const personId of linkedPersonIds) {
      const exists = row<{ id: string }>(
        db.prepare(`SELECT id FROM persons WHERE id = ?`).get(personId),
      )
      if (!exists) continue
      const already = row<{ id: string }>(
        db
          .prepare(
            `SELECT id FROM entity_links
             WHERE entity_kind = 'person' AND entity_id = ? AND entry_id = ?`,
          )
          .get(personId, entryId),
      )
      if (already) continue
      insertLink.run(randomUUID(), personId, entryId, quantomoId, now)
    }

    db.prepare(
      `UPDATE chat_blocks SET
        estado = 'analizado',
        entry_id = ?,
        quantomo_id = ?,
        summary_json = ?
       WHERE id = ?`,
    ).run(
      entryId,
      quantomoId,
      JSON.stringify({
        title,
        summary: extraction.summary,
        quantomo: extraction.quantomo,
        entities: extraction.entities,
        locations: extraction.locations,
        milestones: extraction.milestones,
      }),
      block.id,
    )

    db.prepare(
      `UPDATE chat_messages SET estado_procesamiento = 'analizado'
       WHERE block_id = ?`,
    ).run(block.id)

    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }

  // No embeber en caliente: la trial key Cohere se satura (chat + embed).
  // Los quántomos/entries quedan approved; Mnemosyne puede correr aparte.

  return {
    block_id: block.id,
    entry_id: entryId,
    quantomo_id: quantomoId,
    title,
  }
}

export function listChatSessions(): Array<
  ChatSession & {
    message_count: number
    block_count: number
    link_count: number
    pending_blocks: number
  }
> {
  const db = getDb()
  return rows(
    db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_session_id = s.id) AS message_count,
          (SELECT COUNT(*) FROM chat_blocks b WHERE b.chat_session_id = s.id) AS block_count,
          (SELECT COUNT(*) FROM link_harvest l WHERE l.chat_session_id = s.id) AS link_count,
          (SELECT COUNT(*) FROM chat_blocks b
            WHERE b.chat_session_id = s.id AND b.estado = 'pendiente') AS pending_blocks
         FROM chat_sessions s
         ORDER BY s.created_at DESC`,
      )
      .all(),
  )
}

export function getChatSessionDetail(sessionId: string): {
  session: ChatSession
  blocks: ChatBlock[]
  messages_sample: ChatMessage[]
  stats: {
    message_count: number
    system_count: number
    media_count: number
    link_count: number
    pending_blocks: number
  }
} | null {
  const db = getDb()
  const session = row<ChatSession>(
    db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(sessionId),
  )
  if (!session) return null

  const blocks = rows<ChatBlock>(
    db
      .prepare(
        `SELECT * FROM chat_blocks
         WHERE chat_session_id = ?
         ORDER BY started_at ASC`,
      )
      .all(sessionId),
  )
  const messages_sample = rows<ChatMessage>(
    db
      .prepare(
        `SELECT * FROM chat_messages
         WHERE chat_session_id = ? AND is_system = 0
         ORDER BY timestamp_exact ASC, sort_index ASC
         LIMIT 40`,
      )
      .all(sessionId),
  )

  const statsRow = row<{
    message_count: number
    system_count: number
    media_count: number
  }>(
    db
      .prepare(
        `SELECT
          COUNT(*) AS message_count,
          SUM(CASE WHEN is_system = 1 THEN 1 ELSE 0 END) AS system_count,
          SUM(CASE WHEN is_media = 1 THEN 1 ELSE 0 END) AS media_count
         FROM chat_messages WHERE chat_session_id = ?`,
      )
      .get(sessionId),
  )

  const link_count = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM link_harvest WHERE chat_session_id = ?`,
        )
        .get(sessionId) as { n: number | bigint }
    ).n ?? 0,
  )
  const pending_blocks = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM chat_blocks
           WHERE chat_session_id = ? AND estado = 'pendiente'`,
        )
        .get(sessionId) as { n: number | bigint }
    ).n ?? 0,
  )

  return {
    session,
    blocks,
    messages_sample,
    stats: {
      message_count: Number(statsRow?.message_count ?? 0),
      system_count: Number(statsRow?.system_count ?? 0),
      media_count: Number(statsRow?.media_count ?? 0),
      link_count,
      pending_blocks,
    },
  }
}

export type { ParsedChat }
