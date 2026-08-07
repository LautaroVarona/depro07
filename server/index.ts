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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const PORT = Number(process.env.PORT || 3001)

initDb()
recoverOrphanedProcessing()

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'deprocast-server' })
})

app.use('/api/ingest', ingestRouter)
app.use('/api/entries', entriesRouter)
app.use('/api/pipeline', pipelineRouter)
app.use('/api/proposals', proposalsRouter)
app.use('/api/persons', personsRouter)
app.use('/api/projects', projectsRouter)
app.use('/api/quantomos', quantomosRouter)
app.use('/api/graph', graphRouter)

app.listen(PORT, () => {
  console.log(`[deprocast] server listening on http://localhost:${PORT}`)
})
