import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { getDb } from '../db.js'
import { row, rows } from '../sql.js'
import type { Bookmark, BookmarkSource } from '../types.js'
import {
  approveBookmarkQuantomos,
  applyManualTagsAsLinks,
  listPendingBookmarkQuantomos,
  listOcrReprocessCandidates,
  normalizeImportItem,
  parseBookmarkPayload,
  parseManualTags,
  processHighValueBookmarks,
  reprocessInstagramOcr,
  reprocessInstagramOcrBatch,
} from '../services/bookmarkProcess.js'
import {
  getBookmarkQueueStatus,
  startBookmarkProcess,
  stopBookmarkProcess,
} from '../services/bookmarkQueue.js'
import {
  ensureReelMedia,
  hasFfmpeg,
  resolveLocalMediaAbs,
} from '../services/instagramMedia.js'

export const bookmarksRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 1 },
})

function parseSourceFilter(raw: unknown): BookmarkSource | 'all' {
  const s = String(raw ?? 'all').toLowerCase()
  if (s === 'twitter' || s === 'instagram') return s
  return 'all'
}

function sourceWhere(
  source: BookmarkSource | 'all',
  alias = '',
): { sql: string; params: string[] } {
  const col = alias ? `${alias}.source` : 'source'
  if (source === 'all') return { sql: '1=1', params: [] }
  return {
    sql: `COALESCE(${col}, 'twitter') = ?`,
    params: [source],
  }
}

function counts(
  db: ReturnType<typeof getDb>,
  source: BookmarkSource | 'all' = 'all',
) {
  const sw = sourceWhere(source)
  const total = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE ${sw.sql}`)
        .get(...sw.params),
    )?.n ?? 0),
  )
  const pendientes = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks
           WHERE status = 'PENDIENTE_CRIBA' AND ${sw.sql}`,
        )
        .get(...sw.params),
    )?.n ?? 0),
  )
  const cribados = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks
           WHERE status IN ('CRIBADO', 'PROCESADO_IA', 'SLOP') AND ${sw.sql}`,
        )
        .get(...sw.params),
    )?.n ?? 0),
  )
  const procesados = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks
           WHERE status = 'PROCESADO_IA' AND ${sw.sql}`,
        )
        .get(...sw.params),
    )?.n ?? 0),
  )
  // Listos para el botón Procesar: IG cualquier CRIBADO; Twitter >= 7
  const high_value_ready = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks
           WHERE status = 'CRIBADO'
             AND (
               (COALESCE(source, 'twitter') = 'instagram')
               OR (COALESCE(source, 'twitter') <> 'instagram' AND weight >= 7)
             )
             AND ${sw.sql}`,
        )
        .get(...sw.params),
    )?.n ?? 0),
  )
  const awaiting_approval = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM bookmarks b
           JOIN quantomos q ON q.id = b.quantomo_id
           WHERE b.status = 'PROCESADO_IA' AND q.recognized = 0
             AND ${sourceWhere(source, 'b').sql}`,
        )
        .get(...sourceWhere(source, 'b').params),
    )?.n ?? 0),
  )
  const aprobados = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM bookmarks b
           JOIN quantomos q ON q.id = b.quantomo_id
           WHERE b.status = 'PROCESADO_IA' AND q.recognized = 1
             AND ${sourceWhere(source, 'b').sql}`,
        )
        .get(...sourceWhere(source, 'b').params),
    )?.n ?? 0),
  )
  const validados = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks
           WHERE status = 'CRIBADO' AND ${sw.sql}`,
        )
        .get(...sw.params),
    )?.n ?? 0),
  )
  const slop = Number(
    (row<{ n: number | bigint }>(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks
           WHERE status = 'SLOP' AND ${sw.sql}`,
        )
        .get(...sw.params),
    )?.n ?? 0),
  )

  const bySource = (src: BookmarkSource) => {
    const w = sourceWhere(src)
    return {
      total: Number(
        (row<{ n: number | bigint }>(
          db
            .prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE ${w.sql}`)
            .get(...w.params),
        )?.n ?? 0),
      ),
      pendientes: Number(
        (row<{ n: number | bigint }>(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bookmarks
               WHERE status = 'PENDIENTE_CRIBA' AND ${w.sql}`,
            )
            .get(...w.params),
        )?.n ?? 0),
      ),
      cribados: Number(
        (row<{ n: number | bigint }>(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bookmarks
               WHERE status IN ('CRIBADO', 'PROCESADO_IA', 'SLOP') AND ${w.sql}`,
            )
            .get(...w.params),
        )?.n ?? 0),
      ),
      validados: Number(
        (row<{ n: number | bigint }>(
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bookmarks
               WHERE status = 'CRIBADO' AND ${w.sql}`,
            )
            .get(...w.params),
        )?.n ?? 0),
      ),
    }
  }

  return {
    total,
    pendientes,
    cribados,
    procesados,
    procesados_ia: procesados,
    validados,
    high_value_ready,
    awaiting_approval,
    sin_aprobar: awaiting_approval,
    aprobados,
    slop,
    by_source: {
      twitter: bySource('twitter'),
      instagram: bySource('instagram'),
    },
  }
}

function detectImportSource(
  items: Record<string, unknown>[],
): BookmarkSource | 'mixed' {
  let ig = 0
  let tw = 0
  for (const raw of items) {
    const n = normalizeImportItem(raw)
    if (!n) continue
    if (n.source === 'instagram') ig += 1
    else tw += 1
  }
  if (ig > 0 && tw > 0) return 'mixed'
  if (ig > 0) return 'instagram'
  return 'twitter'
}

function importItems(
  items: Record<string, unknown>[],
): {
  imported: number
  skipped: number
  updated: number
  detected_source: BookmarkSource | 'mixed'
} {
  const db = getDb()
  const now = new Date().toISOString()
  const existing = db.prepare(`SELECT id, status FROM bookmarks WHERE id = ?`)
  const insert = db.prepare(`
    INSERT INTO bookmarks (
      id, text, author_name, author_username, created_at_source, link,
      media_urls, weight, status, category, extracted_entities,
      suggested_links, quantomo, entry_id, quantomo_id, imported_at,
      source, shortcode, media_pk, likes, comments,
      local_media_path, transcript, ocr_json, enrichment_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, NULL, 'PENDIENTE_CRIBA', NULL, '[]',
      '[]', NULL, NULL, NULL, ?,
      ?, ?, ?, ?, ?,
      NULL, NULL, '[]', '{}'
    )
  `)
  const updateRaw = db.prepare(`
    UPDATE bookmarks SET
      text = ?,
      author_name = ?,
      author_username = ?,
      created_at_source = ?,
      link = ?,
      media_urls = ?,
      source = ?,
      shortcode = ?,
      media_pk = ?,
      likes = ?,
      comments = ?
    WHERE id = ? AND status = 'PENDIENTE_CRIBA'
  `)

  let imported = 0
  let skipped = 0
  let updated = 0
  const detected_source = detectImportSource(items)

  db.exec('BEGIN')
  try {
    for (const raw of items) {
      const item = normalizeImportItem(raw)
      if (!item) {
        skipped += 1
        continue
      }
      const prev = row<{ id: string; status: string }>(
        existing.get(item.id),
      )
      if (!prev) {
        insert.run(
          item.id,
          item.text,
          item.author_name,
          item.author_username,
          item.created_at_source,
          item.link,
          item.media_urls,
          now,
          item.source,
          item.shortcode,
          item.media_pk,
          item.likes,
          item.comments,
        )
        imported += 1
        continue
      }
      if (prev.status === 'PENDIENTE_CRIBA') {
        updateRaw.run(
          item.text,
          item.author_name,
          item.author_username,
          item.created_at_source,
          item.link,
          item.media_urls,
          item.source,
          item.shortcode,
          item.media_pk,
          item.likes,
          item.comments,
          item.id,
        )
        updated += 1
      } else {
        skipped += 1
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return { imported, skipped, updated, detected_source }
}

bookmarksRouter.get('/stats', (req, res) => {
  const source = parseSourceFilter(req.query.source)
  res.json({ ok: true, counts: counts(getDb(), source), source })
})

bookmarksRouter.get('/pending', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(50, Number(req.query.limit ?? 20) || 20),
  )
  const rawOrder = String(req.query.order ?? 'asc').toLowerCase()
  const order =
    rawOrder === 'desc' || rawOrder === 'random' ? rawOrder : 'asc'
  const source = parseSourceFilter(req.query.source)
  const sw = sourceWhere(source)

  const orderSql =
    order === 'random'
      ? 'ORDER BY RANDOM()'
      : order === 'desc'
        ? `ORDER BY COALESCE(created_at_source, imported_at) DESC, id DESC`
        : `ORDER BY COALESCE(created_at_source, imported_at) ASC, id ASC`

  const db = getDb()
  const pending = rows<Bookmark>(
    db
      .prepare(
        `SELECT * FROM bookmarks
         WHERE status = 'PENDIENTE_CRIBA' AND ${sw.sql}
         ${orderSql}
         LIMIT ?`,
      )
      .all(...sw.params, limit),
  )
  res.json({ ok: true, pending, order, source, counts: counts(db, source) })
})

bookmarksRouter.get('/processed', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(2000, Number(req.query.limit ?? 200) || 200),
  )
  const minW = clampWeight(req.query.min ?? req.query.minWeight, 1)
  const maxW = clampWeight(req.query.max ?? req.query.maxWeight, 12)
  const lo = Math.min(minW, maxW)
  const hi = Math.max(minW, maxW)
  const source = parseSourceFilter(req.query.source)
  const sw = sourceWhere(source, 'b')
  const approvalRaw = String(req.query.approval ?? 'all').toLowerCase()
  const approval =
    approvalRaw === 'pending' || approvalRaw === 'approved'
      ? approvalRaw
      : 'all'

  let approvalSql = '1=1'
  if (approval === 'pending') approvalSql = 'q.recognized = 0'
  else if (approval === 'approved') approvalSql = 'q.recognized = 1'

  const db = getDb()
  const processed = rows<{
    id: string
    text: string
    author_name: string | null
    author_username: string | null
    created_at_source: string | null
    link: string | null
    weight: number | null
    status: string
    category: string | null
    source: string | null
    quantomo_id: string | null
    entry_id: string | null
    imported_at: string
    title: string | null
    quantomo_content: string | null
    recognized: number | null
    enrichment_json: string | null
    ocr_json: string | null
    local_media_path: string | null
  }>(
    db
      .prepare(
        `SELECT
           b.id, b.text, b.author_name, b.author_username, b.created_at_source,
           b.link, b.weight, b.status, b.category, b.source,
           b.quantomo_id, b.entry_id, b.imported_at,
           b.enrichment_json, b.ocr_json, b.local_media_path,
           q.title AS title,
           q.content AS quantomo_content,
           q.recognized AS recognized
         FROM bookmarks b
         LEFT JOIN quantomos q ON q.id = b.quantomo_id
         WHERE b.status = 'PROCESADO_IA'
           AND b.weight IS NOT NULL
           AND b.weight >= ? AND b.weight <= ?
           AND ${sw.sql}
           AND ${approvalSql}
         ORDER BY b.weight DESC, b.imported_at DESC
         LIMIT ?`,
      )
      .all(lo, hi, ...sw.params, limit),
  )

  const processedWithMeta = processed.map((row) => {
    let ocr_frame_count = 0
    try {
      const enrich = JSON.parse(row.enrichment_json || '{}') as {
        ocr_frame_count?: number
      }
      if (typeof enrich.ocr_frame_count === 'number') {
        ocr_frame_count = enrich.ocr_frame_count
      } else {
        const ocr = JSON.parse(row.ocr_json || '[]') as unknown
        ocr_frame_count = Array.isArray(ocr) ? ocr.length : 0
      }
    } catch {
      ocr_frame_count = 0
    }
    const {
      enrichment_json: _e,
      ocr_json: _o,
      local_media_path: _m,
      ...rest
    } = row
    return {
      ...rest,
      ocr_frame_count,
      needs_ocr:
        (row.source || '') === 'instagram' &&
        (row.weight ?? 0) >= 10 &&
        ocr_frame_count === 0,
    }
  })

  res.json({
    ok: true,
    processed: processedWithMeta,
    filter: { min_weight: lo, max_weight: hi, approval },
    source,
    counts: counts(db, source),
  })
})

/** Primera validación HITL: bookmarks ya puntuados. */
bookmarksRouter.get('/scored', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(2000, Number(req.query.limit ?? 200) || 200),
  )
  const minW = clampWeight(req.query.min ?? req.query.minWeight, 1)
  const maxW = clampWeight(req.query.max ?? req.query.maxWeight, 12)
  const lo = Math.min(minW, maxW)
  const hi = Math.max(minW, maxW)
  const source = parseSourceFilter(req.query.source)
  const sw = sourceWhere(source)
  const statusRaw = String(req.query.status ?? 'all').toLowerCase()
  const statusSql =
    statusRaw === 'cribado'
      ? `status = 'CRIBADO'`
      : `status IN ('CRIBADO', 'PROCESADO_IA', 'SLOP')`

  const db = getDb()
  const scored = rows<Bookmark>(
    db
      .prepare(
        `SELECT * FROM bookmarks
         WHERE weight IS NOT NULL
           AND ${statusSql}
           AND weight >= ? AND weight <= ?
           AND ${sw.sql}
         ORDER BY weight DESC, imported_at DESC
         LIMIT ?`,
      )
      .all(lo, hi, ...sw.params, limit),
  )
  res.json({
    ok: true,
    scored,
    filter: { min_weight: lo, max_weight: hi, status: statusRaw },
    source,
    counts: counts(db, source),
  })
})

/** Export JSON con pesos (mismo shape de import + weight). */
bookmarksRouter.get('/export', (req, res) => {
  const minW = clampWeight(req.query.min ?? req.query.minWeight, 1)
  const maxW = clampWeight(req.query.max ?? req.query.maxWeight, 12)
  const lo = Math.min(minW, maxW)
  const hi = Math.max(minW, maxW)
  const source = parseSourceFilter(req.query.source)
  const sw = sourceWhere(source)

  const db = getDb()
  const rowsBm = rows<Bookmark>(
    db
      .prepare(
        `SELECT * FROM bookmarks
         WHERE weight IS NOT NULL
           AND status IN ('CRIBADO', 'PROCESADO_IA', 'SLOP')
           AND weight >= ? AND weight <= ?
           AND ${sw.sql}
         ORDER BY weight DESC, COALESCE(created_at_source, imported_at) DESC`,
      )
      .all(lo, hi, ...sw.params),
  )

  const bookmarks = rowsBm.map((b) => {
    let mediaUrls: string[] = []
    try {
      const parsed = JSON.parse(b.media_urls || '[]') as unknown
      if (Array.isArray(parsed)) mediaUrls = parsed.map(String)
    } catch {
      mediaUrls = []
    }
    if (b.source === 'instagram') {
      return {
        id: b.id,
        url_video: b.link,
        descripcion_reel: b.text,
        autor: b.author_username,
        likes: b.likes,
        comments: b.comments,
        fecha_mensaje: b.created_at_source,
        shortcode: b.shortcode,
        media_pk: b.media_pk,
        weight: b.weight,
        status: b.status,
        category: b.category,
        quantomo: b.quantomo,
        source: 'instagram',
      }
    }
    return {
      id: b.id,
      text: b.text,
      authorName: b.author_name,
      authorUsername: b.author_username,
      createdAt: b.created_at_source,
      link: b.link,
      mediaUrls,
      weight: b.weight,
      status: b.status,
      category: b.category,
      quantomo: b.quantomo,
      source: b.source || 'twitter',
    }
  })

  res.json({
    exported_at: new Date().toISOString(),
    source: 'deprocast-criba',
    filter: { min_weight: lo, max_weight: hi, source },
    count: bookmarks.length,
    bookmarks,
  })
})

function clampWeight(raw: unknown, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(12, Math.round(n)))
}

bookmarksRouter.post('/import', upload.single('file'), (req, res) => {
  try {
    let items: Record<string, unknown>[] = []

    if (req.file) {
      const text = req.file.buffer.toString('utf8')
      items = parseBookmarkPayload(text, req.file.originalname || '')
    } else if (typeof req.body?.raw === 'string') {
      items = parseBookmarkPayload(
        req.body.raw,
        String(req.body.filename ?? ''),
      )
    } else if (Array.isArray(req.body?.items)) {
      items = req.body.items as Record<string, unknown>[]
    } else {
      res.status(400).json({
        error: 'Enviar { items } JSON, { raw } texto, o multipart file',
      })
      return
    }

    if (items.length === 0) {
      res.status(400).json({ error: 'No se encontraron bookmarks en el archivo' })
      return
    }

    const result = importItems(items)
    res.json({
      ok: true,
      ...result,
      counts: counts(getDb()),
    })
  } catch (err) {
    console.error('[bookmarks/import]', err)
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Import fallido',
    })
  }
})

bookmarksRouter.post('/process-high-value', async (req, res) => {
  const limit = Math.max(
    1,
    Math.min(100, Number(req.body?.limit ?? 25) || 25),
  )
  try {
    const result = await processHighValueBookmarks(limit)
    res.json({
      ok: true,
      ...result,
      counts: counts(getDb()),
    })
  } catch (err) {
    console.error('[bookmarks/process-high-value]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Proceso fallido',
    })
  }
})

/** Encola procesamiento IA en background (no bloquea el voto). */
bookmarksRouter.post('/process/start', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(10000, Number(req.body?.limit ?? 5000) || 5000),
  )
  try {
    const result = startBookmarkProcess({ limit })
    res.status(result.running || result.queued > 0 ? 202 : 200).json({
      ok: true,
      ...result,
      counts: counts(getDb()),
    })
  } catch (err) {
    console.error('[bookmarks/process/start]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'No se pudo iniciar',
    })
  }
})

bookmarksRouter.post('/process/stop', (_req, res) => {
  const result = stopBookmarkProcess()
  res.json({ ok: true, ...result, counts: counts(getDb()) })
})

bookmarksRouter.get('/process/status', (_req, res) => {
  res.json({
    ok: true,
    ...getBookmarkQueueStatus(),
    counts: counts(getDb()),
  })
})

bookmarksRouter.get('/pending-quantomos', (req, res) => {
  const limit = Math.max(
    1,
    Math.min(500, Number(req.query.limit ?? 200) || 200),
  )
  const pending = listPendingBookmarkQuantomos(limit)
  res.json({
    ok: true,
    pending,
    counts: counts(getDb()),
  })
})

bookmarksRouter.post('/approve-quantomos', (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).map(String)
    : undefined
  try {
    const result = approveBookmarkQuantomos(ids)
    res.json({
      ok: true,
      ...result,
      counts: counts(getDb()),
    })
  } catch (err) {
    console.error('[bookmarks/approve-quantomos]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Aprobación fallida',
    })
  }
})

/** Estado de dependencias media (ffmpeg para OCR 10–12). */
bookmarksRouter.get('/media-deps', async (_req, res) => {
  const ffmpeg_ok = await hasFfmpeg()
  const ocr_pending = listOcrReprocessCandidates(5000).length
  res.json({
    ok: true,
    ffmpeg_ok,
    ocr_pending,
    counts: counts(getDb()),
  })
})

/** Reprocesa OCR (frames + Vision + re-extract) de uno o varios IG w≥10. */
bookmarksRouter.post('/reprocess-ocr', async (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? (req.body.ids as unknown[]).map(String).filter(Boolean)
    : undefined
  const limit = Math.max(
    1,
    Math.min(100, Number(req.body?.limit ?? 25) || 25),
  )
  try {
    if (!(await hasFfmpeg())) {
      res.status(503).json({
        ok: false,
        error:
          'ffmpeg no encontrado. Poné ffmpeg.exe en %USERPROFILE%\\bin o tools\\, o FFMPEG_PATH.',
        ffmpeg_ok: false,
      })
      return
    }
    const result = await reprocessInstagramOcrBatch(ids, limit)
    res.json({
      ok: true,
      ...result,
      ffmpeg_ok: true,
      ocr_pending: listOcrReprocessCandidates(5000).length,
      counts: counts(getDb()),
    })
  } catch (err) {
    console.error('[bookmarks/reprocess-ocr]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Reproceso OCR fallido',
    })
  }
})

bookmarksRouter.post('/:id/reprocess-ocr', async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) {
    res.status(400).json({ error: 'id requerido' })
    return
  }
  try {
    if (!(await hasFfmpeg())) {
      res.status(503).json({
        ok: false,
        error:
          'ffmpeg no encontrado. Poné ffmpeg.exe en %USERPROFILE%\\bin o tools\\, o FFMPEG_PATH.',
        ffmpeg_ok: false,
      })
      return
    }
    const item = await reprocessInstagramOcr(id)
    res.json({
      ok: true,
      item,
      ffmpeg_ok: true,
      counts: counts(getDb()),
    })
  } catch (err) {
    console.error('[bookmarks/reprocess-ocr/:id]', err)
    const msg = err instanceof Error ? err.message : 'Reproceso OCR fallido'
    const status =
      /no encontrado|Solo |ffmpeg|Sin media/i.test(msg) ? 400 : 500
    res.status(status).json({ error: msg })
  }
})

/** Descarga lazy del reel (yt-dlp) y persiste local_media_path. */
bookmarksRouter.post('/:id/ensure-media', async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) {
    res.status(400).json({ error: 'id requerido' })
    return
  }
  const db = getDb()
  const existing = row<Bookmark>(
    db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Bookmark no encontrado' })
    return
  }
  if ((existing.source || 'twitter') !== 'instagram') {
    res.status(400).json({ error: 'Solo aplica a Instagram' })
    return
  }
  try {
    const media = await ensureReelMedia(existing)
    if (!media.ok) {
      // 200 + ok:false: fallo esperado (sin yt-dlp / IG bloquea); no spamear 502 en consola
      res.status(200).json({
        ok: false,
        error: media.error,
        link: existing.link,
      })
      return
    }
    res.json({
      ok: true,
      id,
      local_media_path: media.relativePath,
      media_url: `/api/bookmarks/${encodeURIComponent(id)}/media`,
    })
  } catch (err) {
    console.error('[bookmarks/ensure-media]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Media fallida',
    })
  }
})

bookmarksRouter.get('/:id/media', (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) {
    res.status(400).json({ error: 'id requerido' })
    return
  }
  const abs = resolveLocalMediaAbs(id)
  if (!abs) {
    res.status(404).json({ error: 'Media local no disponible' })
    return
  }
  const ext = path.extname(abs).toLowerCase()
  const type =
    ext === '.webm'
      ? 'video/webm'
      : ext === '.mkv'
        ? 'video/x-matroska'
        : 'video/mp4'
  res.setHeader('Content-Type', type)
  res.setHeader('Accept-Ranges', 'bytes')
  fs.createReadStream(abs).pipe(res)
})

bookmarksRouter.post('/:id/weight', (req, res) => {
  const id = String(req.params.id || '').trim()
  const weight = Number(req.body?.weight)
  if (!id) {
    res.status(400).json({ error: 'id requerido' })
    return
  }
  if (!Number.isInteger(weight) || weight < 1 || weight > 12) {
    res.status(400).json({ error: 'weight debe ser entero 1–12' })
    return
  }

  const db = getDb()
  const existing = row<Bookmark>(
    db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Bookmark no encontrado' })
    return
  }
  if (existing.status === 'PROCESADO_IA' || existing.status === 'SLOP') {
    res.status(409).json({ error: 'Ya procesado; no se puede re-pesar' })
    return
  }

  db.prepare(
    `UPDATE bookmarks SET weight = ?, status = 'CRIBADO' WHERE id = ?`,
  ).run(weight, id)

  res.json({
    ok: true,
    id,
    weight,
    status: 'CRIBADO',
    counts: counts(db),
  })
})

bookmarksRouter.patch('/:id/note', (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!id) {
    res.status(400).json({ error: 'id requerido' })
    return
  }

  const db = getDb()
  const existing = row<Bookmark>(
    db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Bookmark no encontrado' })
    return
  }

  const body = (req.body ?? {}) as {
    operator_note?: unknown
    manual_tags?: unknown
  }

  let nextNote =
    existing.operator_note != null ? String(existing.operator_note) : ''
  if (typeof body.operator_note === 'string') {
    nextNote = body.operator_note
  }

  let nextTags = parseManualTags(existing.manual_tags)
  if (body.manual_tags !== undefined) {
    nextTags = parseManualTags(
      typeof body.manual_tags === 'string'
        ? body.manual_tags
        : JSON.stringify(body.manual_tags),
    )
    // Dedupe by kind+id
    const seen = new Set<string>()
    nextTags = nextTags.filter((t) => {
      const k = `${t.kind}:${t.entity_id}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }

  const tagsJson = JSON.stringify(nextTags)
  db.prepare(
    `UPDATE bookmarks SET operator_note = ?, manual_tags = ? WHERE id = ?`,
  ).run(nextNote, tagsJson, id)

  let links_applied = 0
  if (existing.entry_id) {
    links_applied = applyManualTagsAsLinks(
      db,
      { manual_tags: tagsJson },
      existing.entry_id,
      existing.quantomo_id,
    )
  }

  const updated = row<Bookmark>(
    db.prepare(`SELECT * FROM bookmarks WHERE id = ?`).get(id),
  )

  res.json({
    ok: true,
    bookmark: updated,
    links_applied,
  })
})
