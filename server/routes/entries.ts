import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db.js'
import { row, rowRequired, rows } from '../sql.js'
import { removeFromPipelineQueue } from '../services/pipeline.js'
import type {
  Entry,
  PendingTask,
  ProposalBundle,
  Quantomo,
  ValidatedFileMetadata,
} from '../types.js'

export const entriesRouter = Router()

function bundleEntry(entry: Entry, withFileMetadata = false): ProposalBundle {
  const db = getDb()
  const quantomos = rows<Quantomo>(
    db
      .prepare(
        `SELECT * FROM quantomos WHERE entry_id = ? ORDER BY hermetic_weight DESC`,
      )
      .all(entry.id),
  )
  const tasks = rows<PendingTask>(
    db
      .prepare(
        `SELECT * FROM pending_tasks WHERE entry_id = ? ORDER BY rowid ASC`,
      )
      .all(entry.id),
  )

  const bundle: ProposalBundle = { ...entry, quantomos, tasks }

  if (withFileMetadata) {
    const meta = row<ValidatedFileMetadata>(
      db
        .prepare(`SELECT * FROM validated_file_metadata WHERE entry_id = ?`)
        .get(entry.id),
    )
    bundle.file_metadata = meta ?? null
  }

  return bundle
}

function deleteEntryCascade(entryId: string, entry: Entry): void {
  const db = getDb()
  removeFromPipelineQueue(entryId)

  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM validated_file_metadata WHERE entry_id = ?`).run(
      entryId,
    )
    db.prepare(`DELETE FROM quantomos WHERE entry_id = ?`).run(entryId)
    db.prepare(`DELETE FROM pending_tasks WHERE entry_id = ?`).run(entryId)
    db.prepare(`DELETE FROM entry_entities_raw WHERE entry_id = ?`).run(entryId)
    db.prepare(`DELETE FROM entity_proposals WHERE entry_id = ?`).run(entryId)
    db.prepare(`DELETE FROM entity_links WHERE entry_id = ?`).run(entryId)
    db.prepare(
      `DELETE FROM embeddings WHERE object_type = 'entry' AND object_id = ?`,
    ).run(entryId)
    db.prepare(`DELETE FROM entries WHERE id = ?`).run(entryId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  if (entry.vault_path) {
    try {
      const abs = path.resolve(process.cwd(), entry.vault_path)
      const dir = path.dirname(abs)
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn('[entries] vault cleanup failed:', err)
    }
  }
}

entriesRouter.get('/queued', (_req, res) => {
  const queued = rows<Entry>(
    getDb()
      .prepare(
        `SELECT * FROM entries WHERE status IN ('queued', 'processing') ORDER BY created_at ASC`,
      )
      .all(),
  )
  res.json({ entries: queued })
})

/** Elimina todas las cargas activas (queued + processing) y las saca del pipeline. */
entriesRouter.delete('/queued', (_req, res) => {
  const db = getDb()
  const active = rows<Entry>(
    db
      .prepare(
        `SELECT * FROM entries WHERE status IN ('queued', 'processing')`,
      )
      .all(),
  )

  for (const entry of active) {
    deleteEntryCascade(entry.id, entry)
  }

  res.json({ ok: true, deleted: active.length })
})

entriesRouter.get('/validated', (_req, res) => {
  const entries = rows<Entry>(
    getDb()
      .prepare(
        `SELECT * FROM entries WHERE status = 'approved' ORDER BY timestamp_exact DESC, created_at DESC`,
      )
      .all(),
  )

  res.json({ entries: entries.map((e) => bundleEntry(e, true)) })
})

entriesRouter.patch('/timestamp', (req, res) => {
  const { entryId, timestamp_exact } = req.body as {
    entryId?: string
    timestamp_exact?: string
  }

  if (!entryId || !timestamp_exact) {
    res.status(400).json({ error: 'entryId y timestamp_exact son requeridos' })
    return
  }

  const result = getDb()
    .prepare(`UPDATE entries SET timestamp_exact = ? WHERE id = ?`)
    .run(timestamp_exact, entryId)

  if (result.changes === 0) {
    res.status(404).json({ error: 'Entrada no encontrada' })
    return
  }

  const entry = rowRequired<Entry>(
    getDb().prepare(`SELECT * FROM entries WHERE id = ?`).get(entryId),
  )

  res.json({ ok: true, entry })
})

entriesRouter.patch('/title', (req, res) => {
  const { entryId, title } = req.body as {
    entryId?: string
    title?: string
  }

  const trimmed = title?.trim()
  if (!entryId || !trimmed) {
    res.status(400).json({ error: 'entryId y title son requeridos' })
    return
  }

  const result = getDb()
    .prepare(
      `UPDATE entries SET title = ?, title_manual = 1 WHERE id = ?`,
    )
    .run(trimmed, entryId)

  if (result.changes === 0) {
    res.status(404).json({ error: 'Entrada no encontrada' })
    return
  }

  const entry = rowRequired<Entry>(
    getDb().prepare(`SELECT * FROM entries WHERE id = ?`).get(entryId),
  )

  res.json({ ok: true, entry })
})

entriesRouter.delete('/:entryId', (req, res) => {
  const entryId = req.params.entryId
  if (!entryId) {
    res.status(400).json({ error: 'entryId requerido' })
    return
  }

  const db = getDb()
  const entry = row<Entry>(
    db.prepare(`SELECT * FROM entries WHERE id = ?`).get(entryId),
  )

  if (!entry) {
    res.status(404).json({ error: 'Entrada no encontrada' })
    return
  }

  deleteEntryCascade(entryId, entry)
  res.json({ ok: true, entryId })
})
