import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Notebook,
  NotebookIndexEntry,
  NotebookIndexStatus,
  NotebookPage,
  PageStatus,
} from '../types.js'
import { allVisualSlots, TOTAL_FACES, TOTAL_SHEETS } from './notebookLayout.js'
import { row, rows } from '../sql.js'

export function insertEmptyPages(
  database: DatabaseSync,
  notebookId: string,
  now = new Date().toISOString(),
): void {
  const insert = database.prepare(`
    INSERT INTO pages (
      id, notebook_id, slot_index, numero_logico, posicion_visual,
      status, image_path, title, transcription_spatial, graphic_elements,
      is_blank, entry_id, quantomo_id, explanation, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'Vacia', NULL, NULL, NULL, '[]', 0, NULL, NULL, NULL, ?, ?)
  `)
  for (const slot of allVisualSlots()) {
    insert.run(
      randomUUID(),
      notebookId,
      slot.slot_index,
      slot.numero_logico,
      slot.posicion_visual,
      now,
      now,
    )
  }
}

export function createNotebookRecord(
  database: DatabaseSync,
  opts: {
    title: string
    kind: 'fisico' | 'digital'
    cover_url?: string | null
  },
): Notebook {
  const id = randomUUID()
  const now = new Date().toISOString()
  database.exec('BEGIN')
  try {
    database
      .prepare(
        `INSERT INTO notebooks (
          id, title, created_at, kind, cover_url, total_sheets, total_faces,
          index_status, index_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'vacio', '[]', ?)`,
      )
      .run(
        id,
        opts.title.trim() || 'Sin título',
        now,
        opts.kind,
        opts.cover_url ?? null,
        TOTAL_SHEETS,
        TOTAL_FACES,
        now,
      )
    insertEmptyPages(database, id, now)
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
  return row<Notebook>(
    database.prepare(`SELECT * FROM notebooks WHERE id = ?`).get(id),
  )!
}

export function getPage(
  database: DatabaseSync,
  notebookId: string,
  slotIndex: number,
): NotebookPage | undefined {
  return row<NotebookPage>(
    database
      .prepare(
        `SELECT * FROM pages WHERE notebook_id = ? AND slot_index = ?`,
      )
      .get(notebookId, slotIndex),
  )
}

export function listPages(
  database: DatabaseSync,
  notebookId: string,
): NotebookPage[] {
  return rows<NotebookPage>(
    database
      .prepare(
        `SELECT * FROM pages WHERE notebook_id = ? ORDER BY slot_index ASC`,
      )
      .all(notebookId),
  )
}

export function rebuildNotebookIndex(
  database: DatabaseSync,
  notebookId: string,
): { index_json: string; index_status: NotebookIndexStatus } {
  const pages = listPages(database, notebookId)
  const entries: NotebookIndexEntry[] = []
  for (const p of pages) {
    if (
      p.status === 'Procesada' ||
      p.status === 'Validada' ||
      (p.title && p.status === 'PendienteValidacion')
    ) {
      entries.push({
        slot_index: p.slot_index,
        numero_logico: p.numero_logico,
        posicion: p.posicion_visual,
        title: p.title,
        explanation_excerpt: p.explanation
          ? p.explanation.slice(0, 180)
          : null,
        status: p.status as PageStatus,
      })
    }
  }

  const withContent = pages.filter(
    (p) => p.image_path || (p.transcription_spatial && p.transcription_spatial.trim()),
  )
  const processed = withContent.filter((p) => p.status === 'Procesada')
  let index_status: NotebookIndexStatus = 'vacio'
  if (processed.length === 0 && entries.length === 0) {
    index_status = 'vacio'
  } else if (
    withContent.length > 0 &&
    processed.length === withContent.length
  ) {
    index_status = 'completo'
  } else {
    index_status = 'parcial'
  }

  const index_json = JSON.stringify(entries)
  const now = new Date().toISOString()
  database
    .prepare(
      `UPDATE notebooks SET index_json = ?, index_status = ?, updated_at = ? WHERE id = ?`,
    )
    .run(index_json, index_status, now, notebookId)

  return { index_json, index_status }
}

/** Borra cuaderno de producto + pages + entries/quantomos puente + vault. */
export function deleteNotebook(
  database: DatabaseSync,
  notebookId: string,
): { deleted_pages: number; deleted_entries: number } {
  const nb = row<Notebook>(
    database.prepare(`SELECT * FROM notebooks WHERE id = ?`).get(notebookId),
  )
  if (!nb) {
    const err = new Error('Cuaderno no encontrado') as Error & { status?: number }
    err.status = 404
    throw err
  }
  if (nb.kind === 'system') {
    const err = new Error('No se puede borrar Trinchera') as Error & {
      status?: number
    }
    err.status = 400
    throw err
  }

  const pages = listPages(database, notebookId)
  const entryIds = [
    ...new Set(
      pages
        .map((p) => p.entry_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const quantomoIds = [
    ...new Set(
      pages
        .map((p) => p.quantomo_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ]

  database.exec('BEGIN')
  try {
    for (const qid of quantomoIds) {
      database
        .prepare(
          `DELETE FROM embeddings WHERE object_type = 'quantomo' AND object_id = ?`,
        )
        .run(qid)
    }
    for (const entryId of entryIds) {
      database
        .prepare(`DELETE FROM validated_file_metadata WHERE entry_id = ?`)
        .run(entryId)
      database.prepare(`DELETE FROM quantomos WHERE entry_id = ?`).run(entryId)
      database.prepare(`DELETE FROM pending_tasks WHERE entry_id = ?`).run(entryId)
      database
        .prepare(`DELETE FROM entry_entities_raw WHERE entry_id = ?`)
        .run(entryId)
      database
        .prepare(`DELETE FROM entity_proposals WHERE entry_id = ?`)
        .run(entryId)
      database.prepare(`DELETE FROM entity_links WHERE entry_id = ?`).run(entryId)
      database
        .prepare(
          `DELETE FROM embeddings WHERE object_type = 'entry' AND object_id = ?`,
        )
        .run(entryId)
      database.prepare(`DELETE FROM entries WHERE id = ?`).run(entryId)
    }
    database.prepare(`DELETE FROM pages WHERE notebook_id = ?`).run(notebookId)
    database.prepare(`DELETE FROM notebooks WHERE id = ?`).run(notebookId)
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }

  try {
    const vault = path.resolve(process.cwd(), 'vault', 'notebooks', notebookId)
    if (fs.existsSync(vault)) {
      fs.rmSync(vault, { recursive: true, force: true })
    }
  } catch (err) {
    console.warn('[notebooks] vault cleanup failed:', err)
  }

  return {
    deleted_pages: pages.length,
    deleted_entries: entryIds.length,
  }
}
