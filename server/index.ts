import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import express from 'express'
import cors from 'cors'
import { initDb } from './db.js'
import { recoverOrphanedProcessing } from './services/pipeline.js'
import { ingestRouter } from './routes/ingest.js'
import { entriesRouter } from './routes/entries.js'
import { pipelineRouter } from './routes/pipeline.js'
import { proposalsRouter } from './routes/proposals.js'
import { personsRouter } from './routes/persons.js'
import { projectsRouter } from './routes/projects.js'
import { quantomosRouter } from './routes/quantomos.js'
import { graphRouter } from './routes/graph.js'
import { sandboxesRouter } from './routes/sandboxes.js'
import { bookmarksRouter } from './routes/bookmarks.js'
import { agrupacionesRouter } from './routes/agrupaciones.js'
import { notebooksRouter } from './routes/notebooks.js'
import { chatsRouter } from './routes/chats.js'
import { linksRouter } from './routes/links.js'
import { entitiesRouter } from './routes/entities.js'
import { backupRouter } from './routes/backup.js'
import { feedbackRouter } from './routes/feedback.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  override: true,
})
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const PORT = Number(process.env.PORT || 3001)

function cohereKeyFingerprint(): string {
  const raw = (process.env.COHERE_API_KEY || '').replace(/^["']|["']$/g, '')
  if (!raw) return 'ausente'
  const tail = raw.slice(-4)
  return `${raw.length} chars · …${tail}`
}

initDb()
recoverOrphanedProcessing()

const app = express()
app.use(cors())
app.use(express.json({ limit: '25mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'deprocast-server',
    cohere_key: cohereKeyFingerprint(),
  })
})

app.use('/api/ingest', ingestRouter)
app.use('/api/entries', entriesRouter)
app.use('/api/pipeline', pipelineRouter)
app.use('/api/proposals', proposalsRouter)
app.use('/api/persons', personsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/quantomos', quantomosRouter)
app.use('/api/graph', graphRouter)
app.use('/api/sandboxes', sandboxesRouter)
app.use('/api/bookmarks', bookmarksRouter)
app.use('/api/agrupaciones', agrupacionesRouter)
app.use('/api/notebooks', notebooksRouter)
app.use('/api/chats', chatsRouter)
app.use('/api/links', linksRouter)
app.use('/api/entities', entitiesRouter)
app.use('/api/backup', backupRouter)
app.use('/api/feedback', feedbackRouter)

app.listen(PORT, () => {
  console.log(`[deprocast] server listening on http://localhost:${PORT}`)
  console.log(`[deprocast] Cohere key: ${cohereKeyFingerprint()}`)
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[deprocast] puerto ${PORT} ocupado. Cerrá el proceso anterior o matá el PID en ese puerto.`,
    )
  } else {
    console.error('[deprocast] listen error:', err)
  }
  process.exit(1)
})
