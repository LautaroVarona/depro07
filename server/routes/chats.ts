import { Router } from 'express'
import multer from 'multer'
import type { ChatTipo } from '../types.js'
import {
  getChatSessionDetail,
  importChatSession,
  listChatSessions,
  previewChatFile,
  processChatSession,
} from '../services/chatProcess.js'

export const chatsRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024, files: 1 },
})

function parseTipo(raw: unknown): ChatTipo | undefined {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'individual' || s === 'grupo') return s
  return undefined
}

function parsePersonIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw) as unknown
      if (Array.isArray(p)) return p.map(String).filter(Boolean)
    } catch {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
  }
  return []
}

chatsRouter.get('/', (_req, res) => {
  try {
    const sessions = listChatSessions()
    res.json({ ok: true, sessions })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

chatsRouter.post('/preview', upload.single('file'), (req, res) => {
  try {
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'Falta archivo .txt' })
      return
    }
    const parsed = previewChatFile(file.buffer, file.originalname || 'chat.txt')
    res.json({
      ok: true,
      preview: {
        suggested_name: parsed.suggested_name,
        tipo_auto: parsed.tipo_auto,
        participantes: parsed.participantes,
        message_count: parsed.messages.length,
        system_count: parsed.system_count,
        media_count: parsed.media_count,
        link_count: parsed.link_count,
        first_ts: parsed.first_ts,
        last_ts: parsed.last_ts,
        origin_hash: parsed.origin_hash,
      },
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

chatsRouter.post('/import', upload.single('file'), (req, res) => {
  try {
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'Falta archivo .txt' })
      return
    }
    const result = importChatSession({
      buffer: file.buffer,
      filename: file.originalname || 'chat.txt',
      nombre_chat: req.body?.nombre_chat
        ? String(req.body.nombre_chat)
        : undefined,
      tipo: parseTipo(req.body?.tipo),
      person_ids: parsePersonIds(req.body?.person_ids),
    })
    res.json({ ok: true, ...result })
  } catch (err) {
    const e = err as Error & { status?: number; session?: unknown }
    if (e.status === 409) {
      res.status(409).json({
        error: e.message,
        session: e.session,
      })
      return
    }
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

chatsRouter.get('/:id', (req, res) => {
  try {
    const detail = getChatSessionDetail(req.params.id)
    if (!detail) {
      res.status(404).json({ error: 'Sesión no encontrada' })
      return
    }
    res.json({ ok: true, ...detail })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

chatsRouter.post('/:id/process', async (req, res) => {
  const t0 = Date.now()
  console.log('[chats/process] start', req.params.id)
  try {
    const limitRaw = req.body?.limit ?? req.query?.limit
    const limit =
      limitRaw != null && String(limitRaw).trim() !== ''
        ? Number(limitRaw)
        : 2
    const result = await processChatSession(req.params.id, {
      limit: Number.isFinite(limit) ? limit : 2,
    })
    console.log('[chats/process] done', req.params.id, Date.now() - t0, 'ms')
    res.json({ ok: true, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[chats/process] error', msg)
    const status = msg.includes('no encontrada')
      ? 404
      : msg.includes('ya se está procesando')
        ? 409
        : 500
    res.status(status).json({ error: msg })
  }
})
