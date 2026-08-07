import { Router } from 'express'
import path from 'node:path'
import { getDb } from '../db.js'
import { row, rowRequired, rows } from '../sql.js'
import type { Entry, PendingTask, ProposalBundle, Quantomo } from '../types.js'
import { createEntityProposalsFromEntry } from '../services/entityMatch.js'
import {
  embedApprovedEntry,
  enqueueEmbed,
} from '../services/embeddings.js'

export const proposalsRouter = Router()

proposalsRouter.get('/pending', (_req, res) => {
  const db = getDb()
  const entries = rows<Entry>(
    db
      .prepare(
        `SELECT * FROM entries WHERE status = 'pending_review' ORDER BY created_at ASC`,
      )
      .all(),
  )

  const getQuantomos = db.prepare(
    `SELECT * FROM quantomos WHERE entry_id = ? ORDER BY hermetic_weight DESC`,
  )
  const getTasks = db.prepare(
    `SELECT * FROM pending_tasks WHERE entry_id = ? ORDER BY rowid ASC`,
  )

  const proposals: ProposalBundle[] = entries.map((entry) => ({
    ...entry,
    quantomos: rows<Quantomo>(getQuantomos.all(entry.id)),
    tasks: rows<PendingTask>(getTasks.all(entry.id)),
  }))

  res.json({ proposals })
})

proposalsRouter.post('/approve', (req, res) => {
  const {
    entryId,
    title,
    rejectQuantomoIds = [],
    rejectTaskIds = [],
    quantomos,
    tasks,
  } = req.body as {
    entryId?: string
    title?: string
    rejectQuantomoIds?: string[]
    rejectTaskIds?: string[]
    quantomos?: Array<{ id: string; title: string; content: string }>
    tasks?: Array<{ id: string; task_text: string; tag: string }>
  }
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

  let entityProposalsCount = 0

  db.exec('BEGIN')
  try {
    if (typeof title === 'string' && title.trim()) {
      db.prepare(
        `UPDATE entries SET title = ?, title_manual = 1 WHERE id = ?`,
      ).run(title.trim(), entryId)
    }

    if (Array.isArray(quantomos)) {
      const updQ = db.prepare(
        `UPDATE quantomos SET title = ?, content = ? WHERE id = ? AND entry_id = ?`,
      )
      for (const q of quantomos) {
        updQ.run(q.title, q.content, q.id, entryId)
      }
    }

    if (Array.isArray(tasks)) {
      const updT = db.prepare(
        `UPDATE pending_tasks SET task_text = ?, tag = ? WHERE id = ? AND entry_id = ?`,
      )
      for (const t of tasks) {
        updT.run(t.task_text, t.tag || null, t.id, entryId)
      }
    }

    for (const qid of rejectQuantomoIds) {
      db.prepare(`DELETE FROM quantomos WHERE id = ? AND entry_id = ?`).run(
        qid,
        entryId,
      )
    }

    for (const tid of rejectTaskIds) {
      db.prepare(
        `UPDATE pending_tasks SET status = 'rejected' WHERE id = ? AND entry_id = ?`,
      ).run(tid, entryId)
    }

    db.prepare(`UPDATE entries SET status = 'approved' WHERE id = ?`).run(
      entryId,
    )
    db.prepare(
      `UPDATE pending_tasks SET status = 'accepted' WHERE entry_id = ? AND status = 'suggested'`,
    ).run(entryId)
    db.prepare(
      `UPDATE quantomos SET recognized = 1 WHERE entry_id = ?`,
    ).run(entryId)

    const finalEntry = rowRequired<Entry>(
      db.prepare(`SELECT * FROM entries WHERE id = ?`).get(entryId),
    )
    const originalFilename =
      finalEntry.original_filename ||
      (finalEntry.vault_path ? path.basename(finalEntry.vault_path) : null)

    db.prepare(`
      INSERT INTO validated_file_metadata (
        entry_id, assigned_title, timestamp_exact,
        original_filename, transcription, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET
        assigned_title = excluded.assigned_title,
        timestamp_exact = excluded.timestamp_exact,
        original_filename = excluded.original_filename,
        transcription = excluded.transcription,
        stored_at = excluded.stored_at
    `).run(
      entryId,
      finalEntry.title,
      finalEntry.timestamp_exact,
      originalFilename,
      finalEntry.content_raw,
      new Date().toISOString(),
    )

    const entityProposals = createEntityProposalsFromEntry(db, entryId)
    entityProposalsCount = entityProposals.length

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  enqueueEmbed(() => embedApprovedEntry(entryId))

  res.json({
    ok: true,
    entryId,
    status: 'approved',
    entity_proposals: entityProposalsCount,
  })
})

proposalsRouter.post('/reject', (req, res) => {
  const { entryId } = req.body as { entryId?: string }
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

  db.exec('BEGIN')
  try {
    db.prepare(`UPDATE entries SET status = 'rejected' WHERE id = ?`).run(
      entryId,
    )
    db.prepare(
      `UPDATE pending_tasks SET status = 'rejected' WHERE entry_id = ? AND status = 'suggested'`,
    ).run(entryId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  res.json({ ok: true, entryId, status: 'rejected' })
})
