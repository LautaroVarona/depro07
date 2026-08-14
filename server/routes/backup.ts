import { Router } from 'express'
import multer from 'multer'
import {
  backupSummary,
  dumpBackup,
  restoreBackupFromJson,
  serializeBackupCsv,
  serializeBackupJson,
  serializeBackupXml,
} from '../services/backup.js'

export const backupRouter = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
})

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}

backupRouter.get('/summary', (_req, res) => {
  try {
    res.json({ ok: true, ...backupSummary() })
  } catch (err) {
    console.error('[backup/summary]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'No se pudo leer el resumen',
    })
  }
})

backupRouter.get('/', (req, res) => {
  const format = String(req.query.format || 'json').toLowerCase()
  if (format !== 'json' && format !== 'csv' && format !== 'xml') {
    res.status(400).json({ error: 'format debe ser json, csv o xml' })
    return
  }
  try {
    const dump = dumpBackup()
    const day = stamp()
    if (format === 'csv') {
      const body = serializeBackupCsv(dump)
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="deprocast-respaldo-${day}.csv"`,
      )
      res.send(body)
      return
    }
    if (format === 'xml') {
      const body = serializeBackupXml(dump)
      res.setHeader('Content-Type', 'application/xml; charset=utf-8')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="deprocast-respaldo-${day}.xml"`,
      )
      res.send(body)
      return
    }
    const body = serializeBackupJson(dump)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="deprocast-respaldo-${day}.json"`,
    )
    res.send(body)
  } catch (err) {
    console.error('[backup/export]', err)
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Export fallido',
    })
  }
})

backupRouter.post('/restore', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Enviar un archivo JSON de respaldo' })
      return
    }
    const name = req.file.originalname || ''
    if (name && !name.toLowerCase().endsWith('.json')) {
      res.status(400).json({ error: 'Solo se puede restaurar un JSON de respaldo' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(req.file.buffer.toString('utf8'))
    } catch {
      res.status(400).json({ error: 'El archivo no es JSON válido' })
      return
    }
    const result = restoreBackupFromJson(parsed)
    res.json(result)
  } catch (err) {
    console.error('[backup/restore]', err)
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Restore fallido',
    })
  }
})
