import { Router } from 'express'
import {
  backfillLinksFromCorpus,
  listLinks,
} from '../services/linkHarvest.js'

export const linksRouter = Router()

linksRouter.get('/', (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined
    const estado =
      typeof req.query.estado === 'string' ? req.query.estado : undefined
    const source_type =
      typeof req.query.source_type === 'string'
        ? req.query.source_type
        : undefined
    const limit =
      req.query.limit != null ? Number(req.query.limit) : undefined
    const data = listLinks({ q, estado, source_type, limit })
    res.json({ ok: true, ...data })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})

linksRouter.post('/backfill', (_req, res) => {
  try {
    const result = backfillLinksFromCorpus()
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    })
  }
})
