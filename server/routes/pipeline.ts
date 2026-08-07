import { Router } from 'express'
import {
  enqueuePipeline,
  getPipelineStatus,
  isPipelinePaused,
  isPipelineRunning,
  pausePipeline,
  resumePipeline,
} from '../services/pipeline.js'

export const pipelineRouter = Router()

pipelineRouter.post('/run', async (req, res) => {
  try {
    const body = req.body as { entryIds?: string[] } | undefined
    const result = await enqueuePipeline(body?.entryIds)
    res.json({
      ok: true,
      running: isPipelineRunning(),
      paused: isPipelinePaused(),
      ...result,
    })
  } catch (err) {
    console.error('[pipeline/run]', err)
    res.status(500).json({ error: 'No se pudo iniciar el pipeline' })
  }
})

pipelineRouter.post('/pause', (_req, res) => {
  const result = pausePipeline()
  res.json({
    ok: true,
    ...result,
    ...getPipelineStatus(),
    message: 'Pipeline pausado — cola en memoria vaciada',
  })
})

pipelineRouter.post('/resume', (_req, res) => {
  const result = resumePipeline()
  res.json({
    ok: true,
    ...result,
    ...getPipelineStatus(),
    message: 'Pipeline listo — usá Procesar para continuar',
  })
})

pipelineRouter.get('/status', (_req, res) => {
  res.json(getPipelineStatus())
})
