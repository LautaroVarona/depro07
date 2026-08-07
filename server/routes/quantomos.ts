import { Router } from 'express'
import { getDb } from '../db.js'
import { rows, row } from '../sql.js'

export const quantomosRouter = Router()

export type QuantomoView = {
  id: string
  entry_id: string
  title: string
  content: string | null
  hermetic_weight: number | null
  universe: string | null
  recognized: number
  entry_title: string
  entry_status: string
  timestamp_exact: string | null
  original_filename: string | null
  entry_created_at: string
}

quantomosRouter.get('/', (_req, res) => {
  const db = getDb()
  const quantomos = rows<QuantomoView>(
    db
      .prepare(
        `SELECT q.id, q.entry_id, q.title, q.content, q.hermetic_weight,
                q.universe, q.recognized,
                e.title as entry_title, e.status as entry_status,
                e.timestamp_exact, e.original_filename, e.created_at as entry_created_at
         FROM quantomos q
         JOIN entries e ON e.id = q.entry_id
         WHERE q.recognized = 1 AND e.status = 'approved'
         ORDER BY q.hermetic_weight DESC, e.timestamp_exact DESC, e.created_at DESC`,
      )
      .all(),
  )

  const byUniverse = new Map<string, number>()
  let weightSum = 0
  let weightN = 0
  for (const q of quantomos) {
    const u = (q.universe || 'sin universo').trim() || 'sin universo'
    byUniverse.set(u, (byUniverse.get(u) ?? 0) + 1)
    if (typeof q.hermetic_weight === 'number') {
      weightSum += q.hermetic_weight
      weightN += 1
    }
  }

  const universes = [...byUniverse.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  res.json({
    count: quantomos.length,
    avg_weight:
      weightN > 0 ? Math.round((weightSum / weightN) * 100) / 100 : null,
    universes,
    quantomos,
  })
})

quantomosRouter.get('/:id', (req, res) => {
  const db = getDb()
  const quantomo = row<QuantomoView>(
    db
      .prepare(
        `SELECT q.id, q.entry_id, q.title, q.content, q.hermetic_weight,
                q.universe, q.recognized,
                e.title as entry_title, e.status as entry_status,
                e.timestamp_exact, e.original_filename, e.created_at as entry_created_at
         FROM quantomos q
         JOIN entries e ON e.id = q.entry_id
         WHERE q.id = ?`,
      )
      .get(req.params.id),
  )
  if (!quantomo) {
    res.status(404).json({ error: 'Quántomo no encontrado' })
    return
  }

  const siblings = rows<
    Pick<QuantomoView, 'id' | 'title' | 'hermetic_weight' | 'universe'>
  >(
    db
      .prepare(
        `SELECT id, title, hermetic_weight, universe FROM quantomos
         WHERE entry_id = ? AND recognized = 1 AND id != ?
         ORDER BY hermetic_weight DESC`,
      )
      .all(quantomo.entry_id, quantomo.id),
  )

  res.json({ quantomo, siblings })
})
