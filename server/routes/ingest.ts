import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb, getTrincheraNotebookId } from '../db.js'
import { resolveOriginAttribution } from '../services/originAttribution.js'

const VAULT_ROOT = path.resolve(process.cwd(), 'vault')
const INCOMING = path.join(VAULT_ROOT, '_incoming')

fs.mkdirSync(INCOMING, { recursive: true })

/** Disco, no memoria — los m4a de 100–200 MB no caben en RAM vía multer.memoryStorage. */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(INCOMING, { recursive: true })
      cb(null, INCOMING)
    },
    filename: (_req, file, cb) => {
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8')
      const safe = path.basename(original).replace(/[<>:"|?*]/g, '_')
      cb(null, `${randomUUID()}__${safe}`)
    },
  }),
  limits: {
    fileSize: 512 * 1024 * 1024, // 512 MB por archivo
    files: 8,
  },
})

export const ingestRouter = Router()

type CreatedEntry = {
  id: string
  title: string
  title_manual: number
  timestamp_exact: string
  origin_source: string
  status: string
}

function ingestDiskFile(
  file: Express.Multer.File,
  now: Date,
): CreatedEntry {
  const db = getDb()
  const notebookId = getTrincheraNotebookId()
  const entryId = randomUUID()

  const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8')
  const title = originalName.replace(/\.[^.]+$/, '')
  const safeName = path.basename(originalName).replace(/[<>:"|?*]/g, '_')

  const dir = path.join(VAULT_ROOT, entryId)
  fs.mkdirSync(dir, { recursive: true })
  const absVault = path.join(dir, safeName)

  // Mover desde _incoming al vault definitivo
  fs.renameSync(file.path, absVault)

  const vaultPath = path
    .relative(process.cwd(), absVault)
    .split(path.sep)
    .join('/')

  const origin = resolveOriginAttribution({
    filename: originalName,
    fileMtime: null,
    uploadNow: now,
    defaultYear: 2026,
  })

  db.prepare(`
    INSERT INTO entries (
      id, notebook_id, source_type, title, content_raw,
      vault_path, timestamp_exact, status, created_at, title_manual,
      original_filename
    ) VALUES (?, ?, 'audio', ?, NULL, ?, ?, 'queued', ?, 0, ?)
  `).run(
    entryId,
    notebookId,
    title,
    vaultPath,
    origin.timestampExact,
    now.toISOString(),
    originalName,
  )

  console.log(
    `[ingest] «${originalName}» → ${entryId} (${Math.round(file.size / 1024)} KB)`,
  )

  return {
    id: entryId,
    title,
    title_manual: 0,
    timestamp_exact: origin.timestampExact,
    origin_source: origin.source,
    status: 'queued',
  }
}

ingestRouter.post('/audio', (req, res) => {
  upload.array('files', 8)(req, res, (err: unknown) => {
    if (err) {
      console.error('[ingest] multer:', err)
      const message =
        err instanceof multer.MulterError
          ? err.code === 'LIMIT_FILE_SIZE'
            ? 'Archivo demasiado grande (máx. 512 MB)'
            : err.message
          : err instanceof Error
            ? err.message
            : 'Error al subir archivos'
      res.status(400).json({ error: message })
      return
    }

    try {
      const files = req.files as Express.Multer.File[] | undefined
      if (!files || files.length === 0) {
        res.status(400).json({ error: 'No se recibieron archivos' })
        return
      }

      const now = new Date()
      const created: CreatedEntry[] = []

      for (const file of files) {
        try {
          created.push(ingestDiskFile(file, now))
        } catch (fileErr) {
          console.error('[ingest] file failed:', file.originalname, fileErr)
          // limpiar temp si quedó
          try {
            if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path)
          } catch {
            /* ignore */
          }
          throw fileErr
        }
      }

      res.json({ ok: true, entries: created })
    } catch (e) {
      console.error('[ingest]', e)
      res.status(500).json({ error: 'Error al ingerir audio' })
    }
  })
})
