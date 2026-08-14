import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'

const FEEDBACK_ROOT = path.resolve(process.cwd(), 'feedback')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 12,
  },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif|bmp|heic)$/i.test(file.mimetype)) {
      cb(null, true)
      return
    }
    cb(new Error('Solo se aceptan imágenes'))
  },
})

export const feedbackRouter = Router()

type JsonValue = unknown

function parseJsonField(raw: unknown, fallback: JsonValue): JsonValue {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  try {
    return JSON.parse(raw) as JsonValue
  } catch {
    return fallback
  }
}

function stampFolder(id: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  return `${iso}_${id.slice(0, 8)}`
}

function safeExt(file: Express.Multer.File, index: number): string {
  const fromName = path.extname(file.originalname).toLowerCase()
  if (fromName && fromName.length <= 6) return fromName
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
    'image/heic': '.heic',
  }
  return map[file.mimetype] || `.img${index}`
}

function yamlScalar(value: unknown): string {
  if (value == null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const s = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${s}"`
}

function renderNoteMd(opts: {
  id: string
  createdAt: string
  viewId: string
  body: string
  context: Record<string, unknown>
  logs: unknown[]
  images: Array<{ filename: string; originalName: string }>
}): string {
  const ctxLines = Object.entries(opts.context)
    .map(([k, v]) => {
      if (v && typeof v === 'object') {
        return `${k}: ${JSON.stringify(v)}`
      }
      return `${k}: ${yamlScalar(v)}`
    })
    .join('\n')

  const logBlock =
    opts.logs.length === 0
      ? '_sin logs capturados_'
      : opts.logs
          .map((line) => {
            if (line && typeof line === 'object' && 't' in line) {
              const l = line as { t?: string; level?: string; message?: string }
              return `[${l.t ?? ''}] ${l.level ?? 'log'} ${l.message ?? ''}`
            }
            return String(line)
          })
          .join('\n')

  const imgList =
    opts.images.length === 0
      ? '_sin imágenes_'
      : opts.images
          .map((img) => `- \`${img.filename}\` (${img.originalName})`)
          .join('\n')

  return `---
id: ${opts.id}
created_at: ${opts.createdAt}
view: ${yamlScalar(opts.viewId)}
${ctxLines}
---

# Feedback

${opts.body.trim() || '_(sin texto)_'}

## Imágenes

${imgList}

## Logs recientes

\`\`\`
${logBlock}
\`\`\`
`
}

feedbackRouter.post('/', (req, res, next) => {
  upload.array('images', 12)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload inválido'
      res.status(400).json({ error: message })
      return
    }
    next()
  })
}, (req, res) => {
  try {
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const body = String(req.body?.body ?? '')
    const viewId = String(req.body?.view_id ?? '')
    const context = parseJsonField(req.body?.context_json, {}) as Record<
      string,
      unknown
    >
    const logs = parseJsonField(req.body?.logs_json, []) as unknown[]
    const files = (req.files as Express.Multer.File[] | undefined) ?? []

    const folderName = stampFolder(id)
    const folderAbs = path.join(FEEDBACK_ROOT, folderName)
    fs.mkdirSync(folderAbs, { recursive: true })

    const images = files.map((file, i) => {
      const n = String(i + 1).padStart(2, '0')
      const filename = `${n}${safeExt(file, i)}`
      fs.writeFileSync(path.join(folderAbs, filename), file.buffer)
      return {
        filename,
        originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        mime: file.mimetype,
        bytes: file.size,
      }
    })

    const noteMd = renderNoteMd({
      id,
      createdAt,
      viewId,
      body,
      context,
      logs,
      images,
    })
    fs.writeFileSync(path.join(folderAbs, 'nota.md'), noteMd, 'utf8')

    const meta = {
      id,
      created_at: createdAt,
      view_id: viewId,
      body,
      context,
      logs,
      images,
      folder: `feedback/${folderName}`,
    }
    fs.writeFileSync(
      path.join(folderAbs, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8',
    )

    const rel = `feedback/${folderName}`
    getDb()
      .prepare(
        `INSERT INTO feedback_notes (
          id, created_at, view_id, body, context_json, logs_json, images_json, folder_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        createdAt,
        viewId || null,
        body,
        JSON.stringify(context),
        JSON.stringify(logs),
        JSON.stringify(images),
        rel,
      )

    res.json({ ok: true, id, folder: rel, images: images.length })
  } catch (err) {
    console.error('[feedback]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'No se pudo guardar el feedback',
    })
  }
})
