import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { getDb } from '../db.js'
import { TOTAL_FACES, spreadIndexForSlot, slotsForSpread } from './notebookLayout.js'
import { getPage, rebuildNotebookIndex } from './notebookPages.js'
import { enqueueNotebookVision } from './notebookProcess.js'

const require = createRequire(import.meta.url)

export function notebookVaultDir(notebookId: string): string {
  return path.resolve(process.cwd(), 'vault', 'notebooks', notebookId)
}

export function pageImageRelPath(notebookId: string, slotIndex: number): string {
  return path.posix.join(
    'vault',
    'notebooks',
    notebookId,
    'pages',
    `${slotIndex}.png`,
  )
}

/** Heurística: ratio de tinta sobre fondo claro. */
export async function detectBlankPngAsync(absPath: string): Promise<boolean> {
  if (!fs.existsSync(absPath)) return true
  try {
    const { createCanvas, loadImage } =
      require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
    const img = await loadImage(absPath)
    const w = Math.min(img.width, 400)
    const h = Math.min(img.height, 560)
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    let dark = 0
    const total = w * h
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
      if (lum < 220) dark++
    }
    const inkRatio = dark / total
    return inkRatio < 0.012
  } catch (err) {
    console.error('[notebook/blank]', err)
    return false
  }
}

async function rasterizePdfToPngs(
  pdfAbsPath: string,
  outDir: string,
  maxPages: number,
): Promise<{ paths: string[]; totalInPdf: number }> {
  fs.mkdirSync(outDir, { recursive: true })

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const { createCanvas } =
    require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')

  class NodeCanvasFactory {
    create(width: number, height: number) {
      const canvas = createCanvas(width, height)
      const context = canvas.getContext('2d')
      return { canvas, context }
    }
    reset(
      canvasAndContext: { canvas: { width: number; height: number } },
      width: number,
      height: number,
    ) {
      canvasAndContext.canvas.width = width
      canvasAndContext.canvas.height = height
    }
    destroy(canvasAndContext: {
      canvas: { width: number; height: number } | null
      context: unknown
    }) {
      if (canvasAndContext.canvas) {
        canvasAndContext.canvas.width = 0
        canvasAndContext.canvas.height = 0
      }
      canvasAndContext.canvas = null
      canvasAndContext.context = null
    }
  }

  const canvasFactory = new NodeCanvasFactory()
  const data = new Uint8Array(fs.readFileSync(pdfAbsPath))
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    canvasFactory,
  }).promise

  const n = Math.min(doc.numPages, maxPages)
  const paths: string[] = []

  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvasAndContext = canvasFactory.create(
      Math.floor(viewport.width),
      Math.floor(viewport.height),
    )
    await page.render({
      canvasContext: canvasAndContext.context as unknown as CanvasRenderingContext2D,
      canvas: canvasAndContext.canvas,
      viewport,
    }).promise

    const outPath = path.join(outDir, `${i - 1}.png`)
    const png = (
      canvasAndContext.canvas as unknown as {
        toBuffer: (t: string) => Buffer
      }
    ).toBuffer('image/png')
    fs.writeFileSync(outPath, png)
    paths.push(outPath)
    canvasFactory.destroy(canvasAndContext as never)
  }

  return { paths, totalInPdf: doc.numPages }
}

export type IngestPdfResult = {
  notebook_id: string
  pages_imported: number
  pages_blank: number
  pages_truncated: number
  vision_queued: number
  pending_ocr?: number
  warning?: string
}

export type IngestImagesResult = {
  notebook_id: string
  pages_imported: number
  pages_blank: number
  slots_assigned: number[]
  vision_queued: number
  pending_ocr?: number
  warning?: string
}

async function convertImageToPng(
  srcAbsPath: string,
  destAbsPath: string,
): Promise<void> {
  const { createCanvas, loadImage } =
    require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
  const img = await loadImage(srcAbsPath)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, img.width, img.height)
  ctx.drawImage(img, 0, 0)
  fs.mkdirSync(path.dirname(destAbsPath), { recursive: true })
  fs.writeFileSync(destAbsPath, canvas.toBuffer('image/png'))
}

async function assignPngToSlot(
  notebookId: string,
  slot: number,
  pngAbsPath: string,
): Promise<{ blank: boolean; queuedVision: boolean }> {
  const db = getDb()
  const page = getPage(db, notebookId, slot)
  if (!page) throw new Error(`Slot ${slot} inexistente`)

  const pagesDir = path.join(notebookVaultDir(notebookId), 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  const destAbs = path.join(pagesDir, `${slot}.png`)
  if (path.resolve(pngAbsPath) !== path.resolve(destAbs)) {
    fs.copyFileSync(pngAbsPath, destAbs)
  }
  const rel = pageImageRelPath(notebookId, slot)
  const isCoverFace =
    page.posicion_visual === 'Tapa' ||
    page.posicion_visual === 'ImpactoTapa' ||
    page.posicion_visual === 'Contratapa'
  // Tapa/contratapa nunca se auto-descartan por heurística de tinta (suelen ser lisas)
  const blank = isCoverFace ? false : await detectBlankPngAsync(destAbs)
  const now = new Date().toISOString()

  if (blank) {
    db.prepare(
      `UPDATE pages SET
        image_path = ?, is_blank = 1, status = 'Vacia',
        title = NULL, transcription_spatial = NULL,
        graphic_elements = '[]', updated_at = ?
       WHERE id = ?`,
    ).run(rel, now, page.id)
    return { blank: true, queuedVision: false }
  }

  const coverTitle =
    page.posicion_visual === 'Tapa' || page.posicion_visual === 'ImpactoTapa'
      ? 'Tapa'
      : page.posicion_visual === 'Contratapa'
        ? 'Contratapa'
        : null
  const coverTx =
    page.posicion_visual === 'Tapa' || page.posicion_visual === 'ImpactoTapa'
      ? 'tapa'
      : page.posicion_visual === 'Contratapa'
        ? 'contratapa'
        : null

  db.prepare(
    `UPDATE pages SET
      image_path = ?, is_blank = 0, status = 'PendienteVision',
      title = COALESCE(title, ?),
      transcription_spatial = COALESCE(transcription_spatial, ?),
      updated_at = ?
     WHERE id = ?`,
  ).run(rel, coverTitle, coverTx, now, page.id)
  return { blank: false, queuedVision: true }
}

function ensureCoverIfNeeded(notebookId: string, candidateSlot: number): void {
  const db = getDb()
  const nb = db
    .prepare(`SELECT cover_url FROM notebooks WHERE id = ?`)
    .get(notebookId) as { cover_url: string | null } | undefined
  const now = new Date().toISOString()
  const rel = pageImageRelPath(notebookId, candidateSlot)
  if (!nb?.cover_url && fs.existsSync(path.resolve(process.cwd(), rel))) {
    db.prepare(
      `UPDATE notebooks SET cover_url = ?, updated_at = ? WHERE id = ?`,
    ).run(rel, now, notebookId)
  } else {
    db.prepare(`UPDATE notebooks SET updated_at = ? WHERE id = ?`).run(
      now,
      notebookId,
    )
  }
}

/**
 * Imágenes individuales → PNG en slots.
 * mode=append: llena el siguiente slot sin imagen (en orden).
 * mode=from_slot: escribe desde startSlot consecutivos (sobrescribe).
 */
export async function ingestNotebookImages(
  notebookId: string,
  imageAbsPaths: string[],
  opts?: { mode?: 'append' | 'from_slot'; startSlot?: number },
): Promise<IngestImagesResult> {
  const db = getDb()
  const notebook = db
    .prepare(`SELECT id, kind FROM notebooks WHERE id = ?`)
    .get(notebookId) as { id: string; kind: string } | undefined
  if (!notebook) throw new Error('Cuaderno no encontrado')
  if (notebook.kind === 'system') {
    throw new Error('No se puede ingerir imágenes en Trinchera')
  }
  if (imageAbsPaths.length === 0) {
    throw new Error('No hay imágenes')
  }

  const mode = opts?.mode ?? 'append'
  const startSlot = opts?.startSlot ?? 0
  if (
    !Number.isInteger(startSlot) ||
    startSlot < 0 ||
    startSlot >= TOTAL_FACES
  ) {
    throw new Error('startSlot inválido')
  }

  const pagesDir = path.join(notebookVaultDir(notebookId), 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })

  let targetSlots: number[] = []
  if (mode === 'from_slot') {
    const fit = TOTAL_FACES - startSlot
    const take = Math.min(imageAbsPaths.length, fit)
    targetSlots = Array.from({ length: take }, (_, i) => startSlot + i)
  } else {
    const free = db
      .prepare(
        `SELECT slot_index FROM pages
         WHERE notebook_id = ? AND (image_path IS NULL OR image_path = '')
         ORDER BY slot_index ASC`,
      )
      .all(notebookId) as Array<{ slot_index: number }>
    targetSlots = free.slice(0, imageAbsPaths.length).map((r) => r.slot_index)
  }

  const n = Math.min(imageAbsPaths.length, targetSlots.length)
  if (n === 0) {
    return {
      notebook_id: notebookId,
      pages_imported: 0,
      pages_blank: 0,
      slots_assigned: [],
      vision_queued: 0,
      warning:
        mode === 'append'
          ? 'No hay slots libres sin imagen'
          : 'startSlot fuera de rango / sin capacidad',
    }
  }
  let blankCount = 0
  const visionSlots: number[] = []
  const assigned: number[] = []
  const tmpPngs: string[] = []

  try {
    for (let i = 0; i < n; i++) {
      const slot = targetSlots[i]
      const tmpPng = path.join(pagesDir, `_upload_${slot}.png`)
      await convertImageToPng(imageAbsPaths[i], tmpPng)
      tmpPngs.push(tmpPng)
      const result = await assignPngToSlot(notebookId, slot, tmpPng)
      assigned.push(slot)
      if (result.blank) blankCount++
      if (result.queuedVision) visionSlots.push(slot)
    }

    if (visionSlots.length > 0) {
      ensureCoverIfNeeded(notebookId, visionSlots[0])
    } else if (assigned.length > 0) {
      ensureCoverIfNeeded(notebookId, assigned[0])
    } else {
      db.prepare(`UPDATE notebooks SET updated_at = ? WHERE id = ?`).run(
        new Date().toISOString(),
        notebookId,
      )
    }
    rebuildNotebookIndex(db, notebookId)
  } finally {
    for (const t of tmpPngs) {
      try {
        fs.unlinkSync(t)
      } catch {
        /* ignore */
      }
    }
  }

  let warning: string | undefined
  if (imageAbsPaths.length > assigned.length) {
    warning =
      mode === 'append'
        ? `Solo había ${assigned.length} slots libres; ${imageAbsPaths.length - assigned.length} imágenes no se importaron`
        : `Desde slot ${startSlot} cabían ${assigned.length}; ${imageAbsPaths.length - assigned.length} imágenes no se importaron`
  }

  return {
    notebook_id: notebookId,
    pages_imported: assigned.length,
    pages_blank: blankCount,
    slots_assigned: assigned,
    vision_queued: 0,
    pending_ocr: visionSlots.length,
    warning,
  }
}

export async function ingestNotebookPdf(
  notebookId: string,
  pdfAbsPath: string,
): Promise<IngestPdfResult> {
  const db = getDb()
  const notebook = db
    .prepare(`SELECT id, kind FROM notebooks WHERE id = ?`)
    .get(notebookId) as { id: string; kind: string } | undefined
  if (!notebook) throw new Error('Cuaderno no encontrado')
  if (notebook.kind === 'system') {
    throw new Error('No se puede ingerir PDF en Trinchera')
  }

  const vaultRoot = notebookVaultDir(notebookId)
  const pagesDir = path.join(vaultRoot, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })

  const pdfDest = path.join(vaultRoot, 'source.pdf')
  fs.copyFileSync(pdfAbsPath, pdfDest)

  const { paths: rendered, totalInPdf } = await rasterizePdfToPngs(
    pdfAbsPath,
    pagesDir,
    TOTAL_FACES,
  )
  const warning =
    totalInPdf > TOTAL_FACES
      ? `PDF tenía ${totalInPdf} páginas; se importaron solo ${TOTAL_FACES}`
      : undefined

  let blankCount = 0
  const visionSlots: number[] = []
  const now = new Date().toISOString()

  db.exec('BEGIN')
  try {
    for (let slot = 0; slot < rendered.length; slot++) {
      const abs = path.join(pagesDir, `${slot}.png`)
      const result = await assignPngToSlot(notebookId, slot, abs)
      if (result.blank) blankCount++
      if (result.queuedVision) visionSlots.push(slot)
    }

    // Cover: primera imagen no vacía o slot 0
    const coverSlot = visionSlots[0] ?? 0
    const coverRel = pageImageRelPath(notebookId, coverSlot)
    if (fs.existsSync(path.resolve(process.cwd(), coverRel))) {
      db.prepare(
        `UPDATE notebooks SET cover_url = ?, updated_at = ? WHERE id = ?`,
      ).run(coverRel, now, notebookId)
    } else {
      db.prepare(`UPDATE notebooks SET updated_at = ? WHERE id = ?`).run(
        now,
        notebookId,
      )
    }

    rebuildNotebookIndex(db, notebookId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return {
    notebook_id: notebookId,
    pages_imported: rendered.length,
    pages_blank: blankCount,
    pages_truncated: totalInPdf > TOTAL_FACES ? TOTAL_FACES : 0,
    vision_queued: 0,
    pending_ocr: visionSlots.length,
    warning,
  }
}

/** Reemplaza la imagen de un slot (base64 PNG/JPEG) y opcionalmente reencola visión. */
export async function replaceNotebookPageImage(
  notebookId: string,
  slotIndex: number,
  imageBase64: string,
  opts?: { reprocess?: boolean },
): Promise<{ page: import('../types.js').NotebookPage; vision_queued: boolean }> {
  const db = getDb()
  const notebook = db
    .prepare(`SELECT id, kind FROM notebooks WHERE id = ?`)
    .get(notebookId) as { id: string; kind: string } | undefined
  if (!notebook) throw new Error('Cuaderno no encontrado')
  if (notebook.kind === 'system') throw new Error('Trinchera no admite esto')

  const page = getPage(db, notebookId, slotIndex)
  if (!page) throw new Error('Página no encontrada')

  const pagesDir = path.join(notebookVaultDir(notebookId), 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  const abs = path.join(pagesDir, `${slotIndex}.png`)
  const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '')
  const tmp = path.join(pagesDir, `_replace_${slotIndex}.bin`)
  fs.writeFileSync(tmp, Buffer.from(raw, 'base64'))
  try {
    await convertImageToPng(tmp, abs)
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }

  const rel = pageImageRelPath(notebookId, slotIndex)
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE pages SET
      image_path = ?, is_blank = 0, status = 'PendienteVision',
      vision_meta = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(rel, now, page.id)

  ensureCoverIfNeeded(notebookId, slotIndex)
  rebuildNotebookIndex(db, notebookId)

  const reprocess = opts?.reprocess !== false
  if (reprocess) enqueueNotebookVision(notebookId, slotIndex)

  return {
    page: getPage(db, notebookId, slotIndex)!,
    vision_queued: reprocess,
  }
}

/**
 * Aplica rotación (múltiplos de 90) + crop normalizado [x,y,w,h] sobre la imagen actual.
 * Guarda PNG y reencola visión.
 */
export async function transformNotebookPageImage(
  notebookId: string,
  slotIndex: number,
  opts: {
    rotate?: 0 | 90 | 180 | 270
    crop?: [number, number, number, number] | null
    reprocess?: boolean
  },
): Promise<{ page: import('../types.js').NotebookPage; vision_queued: boolean }> {
  const db = getDb()
  const page = getPage(db, notebookId, slotIndex)
  if (!page?.image_path) throw new Error('La página no tiene imagen')

  const abs = path.resolve(process.cwd(), page.image_path)
  if (!fs.existsSync(abs)) throw new Error('Archivo de imagen no encontrado')

  const { createCanvas, loadImage } =
    require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
  const img = await loadImage(abs)
  const rotate = opts.rotate ?? 0

  let sw = img.width
  let sh = img.height
  const rotCanvas = createCanvas(
    rotate === 90 || rotate === 270 ? sh : sw,
    rotate === 90 || rotate === 270 ? sw : sh,
  )
  const rctx = rotCanvas.getContext('2d')
  rctx.translate(rotCanvas.width / 2, rotCanvas.height / 2)
  rctx.rotate((rotate * Math.PI) / 180)
  rctx.drawImage(img, -sw / 2, -sh / 2)

  sw = rotCanvas.width
  sh = rotCanvas.height

  let sx = 0
  let sy = 0
  let cw = sw
  let ch = sh
  if (opts.crop) {
    const [nx, ny, nw, nh] = opts.crop
    sx = Math.floor(Math.min(1, Math.max(0, nx)) * sw)
    sy = Math.floor(Math.min(1, Math.max(0, ny)) * sh)
    cw = Math.max(1, Math.floor(Math.min(1, Math.max(0, nw)) * sw))
    ch = Math.max(1, Math.floor(Math.min(1, Math.max(0, nh)) * sh))
    if (sx + cw > sw) cw = sw - sx
    if (sy + ch > sh) ch = sh - sy
  }

  const out = createCanvas(cw, ch)
  const octx = out.getContext('2d')
  octx.fillStyle = '#ffffff'
  octx.fillRect(0, 0, cw, ch)
  octx.drawImage(rotCanvas, sx, sy, cw, ch, 0, 0, cw, ch)

  const pagesDir = path.join(notebookVaultDir(notebookId), 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  const dest = path.join(pagesDir, `${slotIndex}.png`)
  fs.writeFileSync(dest, out.toBuffer('image/png'))

  const rel = pageImageRelPath(notebookId, slotIndex)
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE pages SET
      image_path = ?, is_blank = 0, status = 'PendienteVision',
      vision_meta = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(rel, now, page.id)

  ensureCoverIfNeeded(notebookId, slotIndex)
  rebuildNotebookIndex(db, notebookId)

  const reprocess = opts.reprocess !== false
  if (reprocess) enqueueNotebookVision(notebookId, slotIndex)

  return {
    page: getPage(db, notebookId, slotIndex)!,
    vision_queued: reprocess,
  }
}

/** Separa un spread: crop izq/der a los slots del par (Izquierda/Derecha). */
export async function splitSpreadToPair(
  notebookId: string,
  fromSlot: number,
): Promise<{
  left_slot: number
  right_slot: number
  left: import('../types.js').NotebookPage
  right: import('../types.js').NotebookPage
}> {
  const db = getDb()
  const source = getPage(db, notebookId, fromSlot)
  if (!source?.image_path) throw new Error('Sin imagen origen')
  if (!source.vision_meta) {
    throw new Error('Sin meta de visión (esperá o dale a Re-visión)')
  }

  let meta: import('../types.js').NotebookPageVisionMeta
  try {
    meta = JSON.parse(
      source.vision_meta,
    ) as import('../types.js').NotebookPageVisionMeta
  } catch {
    throw new Error('vision_meta inválida')
  }
  if (!meta.spread) throw new Error('No se detectó spread a doble página')

  const spreadIdx = spreadIndexForSlot(fromSlot)
  const pair = slotsForSpread(spreadIdx)
  if (pair.length !== 2) {
    throw new Error(
      'Este slot no es una apertura Izq/Der (tapa, página suelta o contratapa)',
    )
  }
  const [leftSlot, rightSlot] = pair

  const abs = path.resolve(process.cwd(), source.image_path)
  const { createCanvas, loadImage } =
    require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
  const img = await loadImage(abs)
  const pagesDir = path.join(notebookVaultDir(notebookId), 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })

  const writeSide = async (
    side: 'left' | 'right',
    slot: number,
  ): Promise<void> => {
    const bbox =
      side === 'left' ? meta.spread!.left_bbox : meta.spread!.right_bbox
    const [nx, ny, nw, nh] = bbox
    const sx = Math.floor(nx * img.width)
    const sy = Math.floor(ny * img.height)
    const cw = Math.max(1, Math.floor(nw * img.width))
    const ch = Math.max(1, Math.floor(nh * img.height))
    const out = createCanvas(cw, ch)
    const ctx = out.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cw, ch)
    ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch)
    const dest = path.join(pagesDir, `${slot}.png`)
    fs.writeFileSync(dest, out.toBuffer('image/png'))

    const target = getPage(db, notebookId, slot)
    if (!target) throw new Error(`Slot ${slot} inexistente`)
    const rel = pageImageRelPath(notebookId, slot)
    const now = new Date().toISOString()
    const title =
      side === 'left' ? meta.spread!.left_title : meta.spread!.right_title
    const transcription =
      side === 'left'
        ? meta.spread!.left_transcription
        : meta.spread!.right_transcription
    db.prepare(
      `UPDATE pages SET
        image_path = ?, is_blank = 0, status = 'PendienteVision',
        title = COALESCE(?, title),
        transcription_spatial = COALESCE(?, transcription_spatial),
        vision_meta = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(rel, title ?? null, transcription ?? null, now, target.id)
    enqueueNotebookVision(notebookId, slot)
  }

  await writeSide('left', leftSlot)
  await writeSide('right', rightSlot)
  rebuildNotebookIndex(db, notebookId)

  return {
    left_slot: leftSlot,
    right_slot: rightSlot,
    left: getPage(db, notebookId, leftSlot)!,
    right: getPage(db, notebookId, rightSlot)!,
  }
}
