import type { DatabaseSync } from 'node:sqlite'
import { ensureTrincheraSeed, getDb, rebuildSearchFts } from '../db.js'
import { pausePipeline } from './pipeline.js'

export const BACKUP_FORMAT = 'deprocast-backup'
export const BACKUP_VERSION = 1

export const BACKUP_TABLES = [
  'notebooks',
  'entries',
  'quantomos',
  'pending_tasks',
  'validated_file_metadata',
  'pages',
  'persons',
  'projects',
  'entity_aliases',
  'project_aliases',
  'entry_entities_raw',
  'entity_proposals',
  'entity_links',
  'person_relations',
  'person_project_links',
  'graph_link_dismissals',
  'agrupaciones',
  'agrupacion_members',
  'bookmarks',
  'chat_sessions',
  'chat_messages',
  'chat_blocks',
  'link_harvest',
  'sandbox_graphs',
  'sandbox_nodes',
  'sandbox_links',
  'embeddings',
] as const

export type BackupTableName = (typeof BACKUP_TABLES)[number]

export type BackupDump = {
  format: typeof BACKUP_FORMAT
  version: number
  exported_at: string
  include_media: false
  tables: Record<string, Record<string, unknown>[]>
}

export type BackupSummary = {
  exported_at: string
  include_media: false
  tables: Record<string, number>
  groups: {
    transcripciones: number
    perfiles: number
    conexiones: number
    quantomos: number
    validaciones: number
    resto: number
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(name) as { ok: number } | undefined
  return Boolean(row)
}

function tableColumns(db: DatabaseSync, name: string): string[] {
  const info = db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
    name: string
  }>
  return info.map((c) => c.name)
}

function countTable(db: DatabaseSync, name: string): number {
  if (!tableExists(db, name)) return 0
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as {
    n: number | bigint
  }
  return Number(row.n ?? 0)
}

function dumpTable(
  db: DatabaseSync,
  name: string,
): Record<string, unknown>[] {
  if (!tableExists(db, name)) return []
  return db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]
}

export function dumpBackup(): BackupDump {
  const db = getDb()
  const tables: BackupDump['tables'] = {}
  for (const name of BACKUP_TABLES) {
    tables[name] = dumpTable(db, name)
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    include_media: false,
    tables,
  }
}

export function backupSummary(): BackupSummary {
  const db = getDb()
  const tables: Record<string, number> = {}
  for (const name of BACKUP_TABLES) {
    tables[name] = countTable(db, name)
  }
  const n = (key: BackupTableName) => tables[key] ?? 0
  return {
    exported_at: new Date().toISOString(),
    include_media: false,
    tables,
    groups: {
      transcripciones: n('entries') + n('chat_messages') + n('pages'),
      perfiles: n('persons') + n('projects'),
      conexiones:
        n('entity_links') +
        n('person_relations') +
        n('person_project_links') +
        n('entity_proposals') +
        n('agrupacion_members'),
      quantomos: n('quantomos'),
      validaciones: n('validated_file_metadata'),
      resto:
        n('notebooks') +
        n('pending_tasks') +
        n('bookmarks') +
        n('chat_sessions') +
        n('chat_blocks') +
        n('link_harvest') +
        n('sandbox_graphs') +
        n('sandbox_nodes') +
        n('sandbox_links') +
        n('embeddings') +
        n('entity_aliases') +
        n('project_aliases') +
        n('entry_entities_raw') +
        n('graph_link_dismissals') +
        n('agrupaciones'),
    },
  }
}

function csvEscape(value: unknown): string {
  if (value == null) return ''
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`
  return s
}

export function serializeBackupJson(dump: BackupDump): string {
  return JSON.stringify(dump, null, 2)
}

export function serializeBackupCsv(dump: BackupDump): string {
  const parts: string[] = [
    `# deprocast-backup v${dump.version}`,
    `# exported_at ${dump.exported_at}`,
    `# include_media false`,
    '',
  ]
  for (const name of BACKUP_TABLES) {
    const rows = dump.tables[name] ?? []
    parts.push(`#TABLE ${name}`)
    if (rows.length === 0) {
      parts.push('')
      continue
    }
    const cols = Object.keys(rows[0])
    parts.push(cols.map(csvEscape).join(','))
    for (const row of rows) {
      parts.push(cols.map((c) => csvEscape(row[c])).join(','))
    }
    parts.push('')
  }
  return parts.join('\n')
}

function xmlEscape(value: unknown): string {
  if (value == null) return ''
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function serializeBackupXml(dump: BackupDump): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<deprocast format="${BACKUP_FORMAT}" version="${dump.version}" exported_at="${xmlEscape(dump.exported_at)}" include_media="false">`,
  ]
  for (const name of BACKUP_TABLES) {
    const rows = dump.tables[name] ?? []
    lines.push(`  <table name="${xmlEscape(name)}">`)
    for (const row of rows) {
      lines.push('    <row>')
      for (const [key, value] of Object.entries(row)) {
        lines.push(
          `      <${key}>${xmlEscape(value)}</${key}>`,
        )
      }
      lines.push('    </row>')
    }
    lines.push('  </table>')
  }
  lines.push('</deprocast>')
  return lines.join('\n')
}

function parseDump(raw: unknown): BackupDump {
  if (!raw || typeof raw !== 'object') {
    throw new Error('El archivo no es un JSON de respaldo válido')
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== BACKUP_FORMAT) {
    throw new Error('El archivo no es un respaldo de Deprocast')
  }
  if (obj.version !== BACKUP_VERSION) {
    throw new Error(`Versión de respaldo no soportada: ${String(obj.version)}`)
  }
  if (!obj.tables || typeof obj.tables !== 'object') {
    throw new Error('El respaldo no contiene tablas')
  }
  const tables: BackupDump['tables'] = {}
  const src = obj.tables as Record<string, unknown>
  for (const name of BACKUP_TABLES) {
    const rows = src[name]
    if (rows == null) {
      tables[name] = []
      continue
    }
    if (!Array.isArray(rows)) {
      throw new Error(`Tabla ${name} no es un array`)
    }
    tables[name] = rows.map((r) => {
      if (!r || typeof r !== 'object') {
        throw new Error(`Fila inválida en ${name}`)
      }
      return r as Record<string, unknown>
    })
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: typeof obj.exported_at === 'string' ? obj.exported_at : '',
    include_media: false,
    tables,
  }
}

function cellValue(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value)
  }
  return value
}

export function restoreBackupFromJson(raw: unknown): {
  ok: true
  tables: Record<string, number>
} {
  const dump = parseDump(raw)
  const db = getDb()
  pausePipeline()

  const deleteOrder = [...BACKUP_TABLES].reverse()

  db.exec('BEGIN')
  try {
    for (const name of deleteOrder) {
      if (tableExists(db, name)) {
        db.exec(`DELETE FROM "${name}"`)
      }
    }

    const inserted: Record<string, number> = {}
    for (const name of BACKUP_TABLES) {
      if (!tableExists(db, name)) {
        inserted[name] = 0
        continue
      }
      const cols = tableColumns(db, name)
      const rows = dump.tables[name] ?? []
      if (rows.length === 0 || cols.length === 0) {
        inserted[name] = 0
        continue
      }
      const placeholders = cols.map(() => '?').join(', ')
      const quoted = cols.map((c) => `"${c}"`).join(', ')
      const stmt = db.prepare(
        `INSERT INTO "${name}" (${quoted}) VALUES (${placeholders})`,
      )
      for (const row of rows) {
        const values = cols.map((c) => cellValue(row[c]))
        stmt.run(...values)
      }
      inserted[name] = rows.length
    }

    rebuildSearchFts(db)
    db.exec('COMMIT')
    ensureTrincheraSeed()
    return { ok: true, tables: inserted }
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  }
}
