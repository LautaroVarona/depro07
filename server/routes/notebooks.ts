import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb } from '../db.js'
import type { GraphicElement, Notebook, NotebookPage } from '../types.js'
import { row, rows } from '../sql.js'
import {
  createNotebookRecord,
  deleteNotebook,
  getPage,
  listPages,
  rebuildNotebookIndex,
} from '../services/notebookPages.js'
import {
  ingestNotebookPdf,
  ingestNotebookImages,
  notebookVaultDir,
  pageImageRelPath,
  detectBlankPngAsync,
  replaceNotebookPageImage,
  transformNotebookPageImage,
  splitSpreadToPair,
} from '../services/notebookIngest.js'
import {
  approveNotebookTranscription,
  composeExplanation,
  enqueueNotebookConfirm,
  enqueueNotebookCorpus,
  enqueueNotebookExplanations,
  enqueueNotebookFullRead,
  enqueueNotebookVision,
  getNotebookVisionQueueStatus,
  parseMentionedEntities,
  splitExplanation,
} from '../services/notebookProcess.js'
import { applyEntityMentionTags } from '../services/blobIngest.js'
import { labelForSlot, mapVisualSlot, TOTAL_FACES } from '../services/notebookLayout.js'

export const notebooksRouter = Router()

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), 'deprocast-notebooks')
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`)
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
})

function requireProductNotebook(id: string): Notebook {
  const nb = row<Notebook>(
    getDb().prepare(`SELECT * FROM notebooks WHERE id = ?`).get(id),
  )
  if (!nb) {
    const err = new Error('Cuaderno no encontrado') as Error & { status?: number }
    err.status = 404
    throw err
  }
  if (nb.kind === 'system') {
    const err = new Error('Trinchera no es un cuaderno de biblioteca') as Error & {
      status?: number
    }
    err.status = 400
    throw err
  }
  return nb
}

notebooksRouter.get('/', (_req, res) => {
  const list = rows<Notebook>(
    getDb()
      .prepare(
        `SELECT * FROM notebooks
         WHERE kind IN ('fisico', 'digital')
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all(),
  )
  res.json({ notebooks: list })
})

notebooksRouter.post('/', (req, res) => {
  const { title, kind } = req.body as {
    title?: string
    kind?: 'fisico' | 'digital'
  }
  if (!kind || (kind !== 'fisico' && kind !== 'digital')) {
    res.status(400).json({ error: 'kind debe ser fisico | digital' })
    return
  }
  const notebook = createNotebookRecord(getDb(), {
    title: title?.trim() || (kind === 'digital' ? 'Cuaderno digital' : 'Cuaderno'),
    kind,
  })
  res.status(201).json({ notebook })
})

notebooksRouter.get('/vision-queue', (_req, res) => {
  res.json(getNotebookVisionQueueStatus())
})

notebooksRouter.post('/:id/full-read', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const result = enqueueNotebookFullRead(req.params.id)
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/process-ocr', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const result = enqueueNotebookFullRead(req.params.id)
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/generate-explanations', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const result = enqueueNotebookExplanations(req.params.id)
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(req.params.id),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/send-to-corpus', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const result = enqueueNotebookCorpus(req.params.id)
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(req.params.id),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.get('/:id', (req, res) => {
  try {
    const notebook = requireProductNotebook(req.params.id)
    const pages = listPages(getDb(), notebook.id)
    let index: unknown[] = []
    try {
      index = JSON.parse(notebook.index_json || '[]') as unknown[]
    } catch {
      index = []
    }
    const summary = {
      total: pages.length,
      vacias: pages.filter((p) => p.status === 'Vacia').length,
      pendiente_vision: pages.filter((p) => p.status === 'PendienteVision')
        .length,
      pendiente_validacion: pages.filter(
        (p) => p.status === 'PendienteValidacion',
      ).length,
      validadas: pages.filter((p) => p.status === 'Validada').length,
      procesadas: pages.filter((p) => p.status === 'Procesada').length,
      with_image: pages.filter((p) => !!p.image_path).length,
    }
    res.json({
      notebook,
      pages,
      index,
      summary,
      vision_queue: getNotebookVisionQueueStatus(notebook.id),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.patch('/:id', (req, res) => {
  try {
    const notebook = requireProductNotebook(req.params.id)
    const { title, cover_url } = req.body as {
      title?: string
      cover_url?: string | null
    }
    const now = new Date().toISOString()
    getDb()
      .prepare(
        `UPDATE notebooks SET
          title = COALESCE(?, title),
          cover_url = CASE WHEN ? IS NOT NULL THEN ? ELSE cover_url END,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        title?.trim() ?? null,
        cover_url === undefined ? null : cover_url,
        cover_url === undefined ? null : cover_url,
        now,
        notebook.id,
      )
    const updated = row<Notebook>(
      getDb().prepare(`SELECT * FROM notebooks WHERE id = ?`).get(notebook.id),
    )
    res.json({ notebook: updated })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.delete('/:id', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const result = deleteNotebook(getDb(), req.params.id)
    res.json({ ok: true, id: req.params.id, ...result })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/delete]', err)
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.post(
  '/:id/ingest-pdf',
  upload.single('file'),
  async (req, res) => {
    try {
      requireProductNotebook(req.params.id)
      if (!req.file) {
        res.status(400).json({ error: 'PDF requerido (campo file)' })
        return
      }
      const result = await ingestNotebookPdf(req.params.id, req.file.path)
      try {
        fs.unlinkSync(req.file.path)
      } catch {
        /* ignore */
      }
      res.json({ ok: true, ...result })
    } catch (err) {
      const e = err as Error & { status?: number }
      console.error('[notebooks/ingest-pdf]', err)
      res.status(e.status || 500).json({ error: e.message })
    }
  },
)

notebooksRouter.post(
  '/:id/ingest-images',
  upload.array('files', 160),
  async (req, res) => {
    try {
      requireProductNotebook(req.params.id)
      const files = (req.files as Express.Multer.File[] | undefined) ?? []
      if (files.length === 0) {
        res.status(400).json({ error: 'Imágenes requeridas (campo files)' })
        return
      }

      const modeRaw = String(req.body?.mode || 'append')
      const mode = modeRaw === 'from_slot' ? 'from_slot' : 'append'
      const startSlot = Number(req.body?.start_slot ?? 0)

      const result = await ingestNotebookImages(
        req.params.id,
        files.map((f) => f.path),
        { mode, startSlot },
      )

      for (const f of files) {
        try {
          fs.unlinkSync(f.path)
        } catch {
          /* ignore */
        }
      }
      res.json({ ok: true, ...result })
    } catch (err) {
      const e = err as Error & { status?: number }
      console.error('[notebooks/ingest-images]', err)
      res.status(e.status || 500).json({ error: e.message })
    }
  },
)

notebooksRouter.get('/:id/pages/:slot', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    if (!Number.isInteger(slot) || slot < 0 || slot >= TOTAL_FACES) {
      res.status(400).json({ error: 'slot inválido' })
      return
    }
    const page = getPage(getDb(), req.params.id, slot)
    if (!page) {
      res.status(404).json({ error: 'Página no encontrada' })
      return
    }
    const meta = mapVisualSlot(slot)
    res.json({ page, label: labelForSlot(meta) })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.get('/:id/pages/:slot/image', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const page = getPage(getDb(), req.params.id, slot)
    if (!page?.image_path) {
      res.status(404).json({ error: 'Sin imagen' })
      return
    }
    const abs = path.resolve(process.cwd(), page.image_path)
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: 'Archivo no encontrado' })
      return
    }
    res.sendFile(abs)
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.patch('/:id/pages/:slot', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const page = getPage(getDb(), req.params.id, slot)
    if (!page) {
      res.status(404).json({ error: 'Página no encontrada' })
      return
    }

    const body = req.body as {
      title?: string
      transcription_spatial?: string
      graphic_elements?: GraphicElement[] | string
      is_blank?: boolean
      status?: string
      numero_logico?: number
      posicion_visual?: string
      explanation?: string
      mentioned_entities?: unknown
    }

    let graphics = page.graphic_elements
    if (body.graphic_elements !== undefined) {
      graphics =
        typeof body.graphic_elements === 'string'
          ? body.graphic_elements
          : JSON.stringify(body.graphic_elements)
    }

    const now = new Date().toISOString()
    let status = page.status
    const nextTitle = body.title !== undefined ? body.title : page.title
    const nextTranscription =
      body.transcription_spatial !== undefined
        ? body.transcription_spatial
        : page.transcription_spatial
    const hasContent =
      Boolean(nextTitle?.trim()) || Boolean(nextTranscription?.trim())

    let isBlank: number | null =
      body.is_blank === undefined ? null : body.is_blank ? 1 : 0
    if (body.is_blank === undefined && hasContent) {
      isBlank = 0
    }

    if (body.is_blank === true) {
      status = 'Vacia'
    } else if (
      body.status &&
      ['Vacia', 'PendienteVision', 'PendienteValidacion', 'Validada', 'Procesada'].includes(
        body.status,
      )
    ) {
      status = body.status as NotebookPage['status']
    }

    if (page.status === 'Procesada' && body.status !== 'Vacia') {
      status = 'Procesada'
    }
    // Guardar no aprueba: no subir a Validada salvo que el cliente lo pida explícito
    if (
      status === 'Validada' &&
      page.status !== 'Validada' &&
      page.status !== 'Procesada' &&
      body.status !== 'Validada'
    ) {
      status = page.status
    }

    let nextExplanation = page.explanation
    let nextExplanationUser = page.explanation_user
    if (body.explanation !== undefined) {
      const user = body.explanation.trim()
      const ai = splitExplanation(page.explanation, page.explanation_user).ai
      nextExplanationUser = user || null
      nextExplanation = composeExplanation(user, ai) || null
    }

    getDb()
      .prepare(
        `UPDATE pages SET
          title = COALESCE(?, title),
          transcription_spatial = COALESCE(?, transcription_spatial),
          graphic_elements = ?,
          is_blank = COALESCE(?, is_blank),
          numero_logico = COALESCE(?, numero_logico),
          posicion_visual = COALESCE(?, posicion_visual),
          explanation = ?,
          explanation_user = ?,
          mentioned_entities = COALESCE(?, mentioned_entities),
          status = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.title ?? null,
        body.transcription_spatial ?? null,
        graphics,
        isBlank,
        body.numero_logico ?? null,
        body.posicion_visual ?? null,
        nextExplanation,
        nextExplanationUser,
        body.mentioned_entities !== undefined
          ? JSON.stringify(parseMentionedEntities(body.mentioned_entities))
          : null,
        status,
        now,
        page.id,
      )

    // Si ya hay quantomo, sincronizar título/explicación
    const updatedPage = getPage(getDb(), req.params.id, slot)
    if (updatedPage?.quantomo_id) {
      getDb()
        .prepare(
          `UPDATE quantomos SET
            title = COALESCE(?, title),
            content = COALESCE(?, content)
           WHERE id = ?`,
        )
        .run(
          body.title ?? null,
          body.explanation ?? null,
          updatedPage.quantomo_id,
        )
    }
    if (updatedPage?.entry_id && (body.title || body.transcription_spatial || body.explanation)) {
      const entry = getDb()
        .prepare(`SELECT content_raw FROM entries WHERE id = ?`)
        .get(updatedPage.entry_id) as { content_raw: string | null } | undefined
      if (entry && body.explanation !== undefined) {
        // refrescar bloque de explicación en content_raw si existe
        const base = (entry.content_raw || '').replace(
          /\n\n\[Explicación\]\n[\s\S]*$/,
          '',
        )
        const contentRaw = `${base}\n\n[Explicación]\n${body.explanation}`
        getDb()
          .prepare(
            `UPDATE entries SET title = COALESCE(?, title), content_raw = ? WHERE id = ?`,
          )
          .run(body.title ?? null, contentRaw, updatedPage.entry_id)
      } else if (body.title !== undefined) {
        getDb()
          .prepare(`UPDATE entries SET title = ? WHERE id = ?`)
          .run(body.title, updatedPage.entry_id)
      }
    }

    rebuildNotebookIndex(getDb(), req.params.id)
    const saved = getPage(getDb(), req.params.id, slot)
    if (
      saved?.entry_id &&
      saved.quantomo_id &&
      body.mentioned_entities !== undefined
    ) {
      applyEntityMentionTags(
        parseMentionedEntities(body.mentioned_entities),
        saved.entry_id,
        saved.quantomo_id,
        now,
      )
    }
    res.json({ page: saved })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/pages/:slot/reprocess-vision', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const page = getPage(getDb(), req.params.id, slot)
    if (!page?.image_path) {
      res.status(400).json({ error: 'La página no tiene imagen' })
      return
    }
    getDb()
      .prepare(
        `UPDATE pages SET status = 'PendienteVision', is_blank = 0, updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), page.id)
    enqueueNotebookVision(req.params.id, slot)
    res.json({ ok: true, queued: true, vision_queue: getNotebookVisionQueueStatus() })
  } catch (err) {
    const e = err as Error & { status?: number }
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.put('/:id/pages/:slot/image', async (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const body = req.body as {
      image_base64?: string
      reprocess?: boolean
    }
    if (!body.image_base64) {
      res.status(400).json({ error: 'image_base64 requerido' })
      return
    }
    const result = await replaceNotebookPageImage(
      req.params.id,
      slot,
      body.image_base64,
      { reprocess: body.reprocess !== false },
    )
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/replace-image]', err)
    res.status(e.status || 500).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/pages/:slot/transform', async (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const body = req.body as {
      rotate?: 0 | 90 | 180 | 270
      crop?: [number, number, number, number] | null
      reprocess?: boolean
    }
    const result = await transformNotebookPageImage(req.params.id, slot, {
      rotate: body.rotate ?? 0,
      crop: body.crop ?? null,
      reprocess: body.reprocess !== false,
    })
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/transform]', err)
    const client =
      e.message?.includes('imagen') || e.message?.includes('encontrado')
    res.status(e.status || (client ? 400 : 500)).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/pages/:slot/split-spread', async (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const result = await splitSpreadToPair(req.params.id, slot)
    res.json({
      ok: true,
      ...result,
      vision_queue: getNotebookVisionQueueStatus(),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/split-spread]', err)
    res.status(e.status || 400).json({ error: e.message })
  }
})

notebooksRouter.post('/:id/pages/:slot/approve-transcription', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const page = approveNotebookTranscription(req.params.id, slot)
    res.json({
      ok: true,
      page,
      vision_queue: getNotebookVisionQueueStatus(req.params.id),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/approve-transcription]', err)
    const msg = e.message || 'Error'
    const client =
      msg.includes('vacía') ||
      msg.includes('Falta') ||
      msg.includes('no encontrada') ||
      msg.includes('Trinchera')
    res.status(e.status || (client ? 400 : 500)).json({ error: msg })
  }
})

notebooksRouter.post('/:id/pages/:slot/confirm', (req, res) => {
  try {
    requireProductNotebook(req.params.id)
    const slot = Number(req.params.slot)
    const result = enqueueNotebookConfirm(req.params.id, slot)
    res.json({
      ok: true,
      queued: true,
      already: result.already,
      vision_queue: getNotebookVisionQueueStatus(req.params.id),
    })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/confirm]', err)
    const msg = e.message || 'Error'
    const client =
      msg.includes('vacía') ||
      msg.includes('Falta') ||
      msg.includes('no encontrada') ||
      msg.includes('Trinchera')
    res.status(e.status || (client ? 400 : 500)).json({ error: msg })
  }
})

/** Guarda cara digital: PNG base64 + transcription/graphics del lienzo. */
notebooksRouter.put('/:id/pages/:slot/canvas', async (req, res) => {
  try {
    const notebook = requireProductNotebook(req.params.id)
    if (notebook.kind !== 'digital') {
      res.status(400).json({ error: 'Solo cuadernos digitales' })
      return
    }
    const slot = Number(req.params.slot)
    if (!Number.isInteger(slot) || slot < 0 || slot >= TOTAL_FACES) {
      res.status(400).json({ error: 'slot inválido' })
      return
    }
    const page = getPage(getDb(), notebook.id, slot)
    if (!page) {
      res.status(404).json({ error: 'Página no encontrada' })
      return
    }

    const body = req.body as {
      image_base64?: string
      title?: string
      transcription_spatial?: string
      graphic_elements?: GraphicElement[]
      run_vision?: boolean
    }

    const pagesDir = path.join(notebookVaultDir(notebook.id), 'pages')
    fs.mkdirSync(pagesDir, { recursive: true })
    const abs = path.join(pagesDir, `${slot}.png`)
    const rel = pageImageRelPath(notebook.id, slot)

    if (body.image_base64) {
      const raw = body.image_base64.replace(/^data:image\/\w+;base64,/, '')
      fs.writeFileSync(abs, Buffer.from(raw, 'base64'))
    }

    const now = new Date().toISOString()
    const graphics = JSON.stringify(body.graphic_elements ?? [])
    const blank = body.image_base64
      ? await detectBlankPngAsync(abs)
      : page.is_blank === 1

    let status: NotebookPage['status'] = 'PendienteValidacion'
    if (blank && !(body.transcription_spatial || '').trim()) {
      status = 'Vacia'
    }

    getDb()
      .prepare(
        `UPDATE pages SET
          image_path = ?,
          title = COALESCE(?, title),
          transcription_spatial = COALESCE(?, transcription_spatial),
          graphic_elements = ?,
          is_blank = ?,
          status = ?,
          updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.image_base64 ? rel : page.image_path,
        body.title ?? null,
        body.transcription_spatial ?? null,
        graphics,
        blank ? 1 : 0,
        status,
        now,
        page.id,
      )

    if (!notebook.cover_url && body.image_base64 && !blank) {
      getDb()
        .prepare(
          `UPDATE notebooks SET cover_url = ?, updated_at = ? WHERE id = ?`,
        )
        .run(rel, now, notebook.id)
    } else {
      getDb()
        .prepare(`UPDATE notebooks SET updated_at = ? WHERE id = ?`)
        .run(now, notebook.id)
    }

    rebuildNotebookIndex(getDb(), notebook.id)

    if (body.run_vision && body.image_base64 && !blank) {
      enqueueNotebookVision(notebook.id, slot)
    }

    const updated = getPage(getDb(), notebook.id, slot)
    res.json({ page: updated, vision_queue: getNotebookVisionQueueStatus() })
  } catch (err) {
    const e = err as Error & { status?: number }
    console.error('[notebooks/canvas]', err)
    res.status(e.status || 500).json({ error: e.message })
  }
})
