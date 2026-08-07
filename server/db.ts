/**
 * Persistencia local SQLite vía `node:sqlite` (DatabaseSync, Node 22+).
 * Preferido sobre better-sqlite3 aquí porque no requiere toolchain nativo/Python en Windows.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FALLBACK_TIMESTAMP,
  parseFromFilename,
  parseFromTranscript,
} from './services/originAttribution.js'

const DATA_DIR = path.resolve(process.cwd(), 'data')
const DB_PATH = path.join(DATA_DIR, 'deprocast.db')

let db: DatabaseSync

export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  seed(db)
  return db
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS notebooks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      notebook_id TEXT,
      source_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content_raw TEXT,
      vault_path TEXT,
      timestamp_exact TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      title_manual INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS quantomos (
      id TEXT PRIMARY KEY,
      entry_id TEXT,
      title TEXT NOT NULL,
      content TEXT,
      hermetic_weight INTEGER,
      universe TEXT,
      recognized INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS pending_tasks (
      id TEXT PRIMARY KEY,
      entry_id TEXT,
      task_text TEXT NOT NULL,
      tag TEXT,
      status TEXT DEFAULT 'suggested'
    );

    CREATE TABLE IF NOT EXISTS validated_file_metadata (
      entry_id TEXT PRIMARY KEY,
      assigned_title TEXT NOT NULL,
      timestamp_exact TEXT,
      original_filename TEXT,
      transcription TEXT,
      stored_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS persons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'activo',
      tactical_focus TEXT,
      notes TEXT,
      aliases TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS entry_entities_raw (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS entity_proposals (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      proposal_type TEXT NOT NULL,
      suggested_name TEXT NOT NULL,
      suggested_meta TEXT NOT NULL DEFAULT '{}',
      matched_entity_id TEXT,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS entity_links (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      quantomo_id TEXT,
      role TEXT NOT NULL DEFAULT 'mentioned',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_aliases (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(object_type, object_id, model)
    );

    CREATE TABLE IF NOT EXISTS person_relations (
      id TEXT PRIMARY KEY,
      from_person_id TEXT NOT NULL,
      to_person_id TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'vinculo',
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(from_person_id, to_person_id, relation_type)
    );

    CREATE TABLE IF NOT EXISTS person_project_links (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'miembro',
      created_at TEXT NOT NULL,
      UNIQUE(person_id, project_id)
    );
  `)

  ensureColumn(database, 'entries', 'title_manual', 'INTEGER DEFAULT 0')
  ensureColumn(database, 'entries', 'original_filename', 'TEXT')
  ensureColumn(database, 'persons', 'merged_into', 'TEXT')
  ensureColumn(database, 'persons', 'is_operator', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(database, 'projects', 'merged_into', 'TEXT')
  ensureColumn(database, 'projects', 'aliases', `TEXT NOT NULL DEFAULT '[]'`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS person_relations (
      id TEXT PRIMARY KEY,
      from_person_id TEXT NOT NULL,
      to_person_id TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'vinculo',
      notes TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(from_person_id, to_person_id, relation_type)
    );

    CREATE TABLE IF NOT EXISTS person_project_links (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'miembro',
      created_at TEXT NOT NULL,
      UNIQUE(person_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS project_aliases (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_norm TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_link_dismissals (
      id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(person_id, project_id)
    );
  `)
  backfillOriginalFilenames(database)
  backfillValidatedFileMetadata(database)
  backfillUnclearTimestamps(database)
  migratePersonKinds(database)
  migrateProjectKinds(database)
  ensureEntityAliasIndex(database)
  ensureProjectAliasIndex(database)
  ensureEntityLinksIndex(database)
  backfillEntityAliases(database)
  backfillProjectAliases(database)
}

/** Rellena original_filename desde vault_path cuando falta. */
function backfillOriginalFilenames(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT id, vault_path FROM entries
       WHERE original_filename IS NULL AND vault_path IS NOT NULL`,
    )
    .all() as Array<{ id: string; vault_path: string }>

  if (rows.length === 0) return

  const upd = database.prepare(
    `UPDATE entries SET original_filename = ? WHERE id = ?`,
  )
  for (const row of rows) {
    const name = path.basename(row.vault_path)
    if (name) upd.run(name, row.id)
  }
}

/** Congela metadata de entradas ya aprobadas que aún no tienen snapshot. */
function backfillValidatedFileMetadata(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT e.id, e.title, e.timestamp_exact, e.original_filename,
              e.vault_path, e.content_raw
       FROM entries e
       LEFT JOIN validated_file_metadata m ON m.entry_id = e.id
       WHERE e.status = 'approved' AND m.entry_id IS NULL`,
    )
    .all() as Array<{
      id: string
      title: string
      timestamp_exact: string | null
      original_filename: string | null
      vault_path: string | null
      content_raw: string | null
    }>

  if (rows.length === 0) return

  const insert = database.prepare(`
    INSERT INTO validated_file_metadata (
      entry_id, assigned_title, timestamp_exact,
      original_filename, transcription, stored_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `)
  const now = new Date().toISOString()
  for (const row of rows) {
    const original =
      row.original_filename ||
      (row.vault_path ? path.basename(row.vault_path) : null)
    insert.run(
      row.id,
      row.title,
      row.timestamp_exact,
      original,
      row.content_raw,
      now,
    )
  }
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  if (!cols.some((c) => c.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/**
 * Prueba: si no hay fecha parseable en nombre ni en transcripción,
 * fija timestamp_exact al 3 de marzo de 2026 (entradas aún no validadas).
 */
function backfillUnclearTimestamps(database: DatabaseSync): void {
  const rows = database
    .prepare(
      `SELECT id, original_filename, title, content_raw, timestamp_exact
       FROM entries
       WHERE status IN ('queued', 'processing', 'pending_review')`,
    )
    .all() as Array<{
    id: string
    original_filename: string | null
    title: string
    content_raw: string | null
    timestamp_exact: string | null
  }>

  const upd = database.prepare(
    `UPDATE entries SET timestamp_exact = ? WHERE id = ?`,
  )
  let n = 0
  for (const row of rows) {
    const name = row.original_filename || row.title
    const clear =
      parseFromFilename(name, 2026) ||
      parseFromTranscript(row.content_raw ?? '', 2026)
    if (clear) continue
    if (row.timestamp_exact === FALLBACK_TIMESTAMP) continue
    upd.run(FALLBACK_TIMESTAMP, row.id)
    n++
  }
  if (n > 0) {
    console.log(
      `[db] backfill unclear timestamps → 2026-03-03 (${n} entries)`,
    )
  }
}

function migratePersonKinds(database: DatabaseSync): void {
  const n = database
    .prepare(`UPDATE persons SET kind = 'ficticia' WHERE kind = 'agrupacion'`)
    .run()
  if (n.changes > 0) {
    console.log(`[db] persons kind agrupacion → ficticia (${n.changes})`)
  }
  const pending = database
    .prepare(
      `SELECT id, suggested_meta FROM entity_proposals
       WHERE kind = 'person' AND status = 'pending'`,
    )
    .all() as Array<{ id: string; suggested_meta: string }>
  const upd = database.prepare(
    `UPDATE entity_proposals SET suggested_meta = ? WHERE id = ?`,
  )
  let m = 0
  for (const row of pending) {
    try {
      const meta = JSON.parse(row.suggested_meta || '{}') as Record<
        string,
        unknown
      >
      if (meta.kind === 'agrupacion' || meta.kind === 'ficticio') {
        meta.kind = 'ficticia'
        upd.run(JSON.stringify(meta), row.id)
        m++
      }
    } catch {
      /* ignore */
    }
  }
  if (m > 0) {
    console.log(`[db] pending proposals kind → ficticia (${m})`)
  }
}

/** Normaliza category libre → proyecto | tarea | concepto. */
function migrateProjectKinds(database: DatabaseSync): void {
  const rows = database
    .prepare(`SELECT id, category FROM projects`)
    .all() as Array<{ id: string; category: string | null }>
  const upd = database.prepare(`UPDATE projects SET category = ? WHERE id = ?`)
  let n = 0
  for (const row of rows) {
    const raw = String(row.category ?? '')
      .trim()
      .toLowerCase()
    let next = 'proyecto'
    if (
      raw === 'tarea' ||
      raw === 'tareas' ||
      raw === 'reto' ||
      raw === 'retos' ||
      raw === 'tarea-reto' ||
      raw === 'tareas-retos'
    ) {
      next = 'tarea'
    } else if (raw === 'concepto' || raw === 'conceptos' || raw === 'idea') {
      next = 'concepto'
    } else if (raw === 'proyecto' || raw === 'proyectos') {
      next = 'proyecto'
    } else if (!raw) {
      next = 'proyecto'
    } else {
      // valores libres previos → proyecto (tipo operativo por defecto)
      next = 'proyecto'
    }
    if (row.category !== next) {
      upd.run(next, row.id)
      n++
    }
  }
  if (n > 0) {
    console.log(`[db] projects category → kind (${n})`)
  }
}

function ensureEntityAliasIndex(database: DatabaseSync): void {
  // Dedup before UNIQUE (legacy DBs may have duplicate alias_norm per person).
  database.exec(`
    DELETE FROM entity_aliases
    WHERE id NOT IN (
      SELECT MIN(id) FROM entity_aliases GROUP BY person_id, alias_norm
    );
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_norm ON entity_aliases(alias_norm);
    CREATE INDEX IF NOT EXISTS idx_entity_aliases_person ON entity_aliases(person_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_aliases_person_norm
      ON entity_aliases(person_id, alias_norm);
  `)
}

function ensureProjectAliasIndex(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM project_aliases
    WHERE id NOT IN (
      SELECT MIN(id) FROM project_aliases GROUP BY project_id, alias_norm
    );
    CREATE INDEX IF NOT EXISTS idx_project_aliases_norm ON project_aliases(alias_norm);
    CREATE INDEX IF NOT EXISTS idx_project_aliases_project ON project_aliases(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_aliases_project_norm
      ON project_aliases(project_id, alias_norm);
  `)
}

function ensureEntityLinksIndex(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_entity_links_entry ON entity_links(entry_id);
    CREATE INDEX IF NOT EXISTS idx_entity_links_kind_id
      ON entity_links(entity_kind, entity_id);
  `)
}

function backfillProjectAliases(database: DatabaseSync): void {
  const count = database
    .prepare(`SELECT COUNT(*) as c FROM project_aliases`)
    .get() as { c: number }
  if (count.c > 0) return

  const projects = database
    .prepare(`SELECT id, title, aliases FROM projects`)
    .all() as Array<{ id: string; title: string; aliases: string | null }>
  if (projects.length === 0) return

  const insert = database.prepare(`
    INSERT INTO project_aliases (id, project_id, alias, alias_norm, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  const now = new Date().toISOString()
  let n = 0
  database.exec('BEGIN')
  try {
    for (const p of projects) {
      n += syncProjectAliasesTx(
        database,
        insert,
        p.id,
        p.title,
        p.aliases || '[]',
        now,
      )
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
  if (n > 0) {
    console.log(`[db] backfill project_aliases (${n} rows)`)
  }
}

function backfillEntityAliases(database: DatabaseSync): void {
  const count = database
    .prepare(`SELECT COUNT(*) as c FROM entity_aliases`)
    .get() as { c: number }
  if (count.c > 0) return

  const persons = database
    .prepare(`SELECT id, name, aliases FROM persons`)
    .all() as Array<{ id: string; name: string; aliases: string }>
  if (persons.length === 0) return

  const insert = database.prepare(`
    INSERT INTO entity_aliases (id, person_id, alias, alias_norm, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  const now = new Date().toISOString()
  let n = 0
  database.exec('BEGIN')
  try {
    for (const p of persons) {
      n += syncPersonAliasesTx(database, insert, p.id, p.name, p.aliases, now)
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }
  if (n > 0) {
    console.log(`[db] backfill entity_aliases (${n} rows)`)
  }
}

function syncPersonAliasesTx(
  database: DatabaseSync,
  insert: ReturnType<DatabaseSync['prepare']>,
  personId: string,
  name: string,
  aliasesJson: string,
  now: string,
): number {
  database
    .prepare(`DELETE FROM entity_aliases WHERE person_id = ?`)
    .run(personId)
  const aliases = new Set<string>()
  aliases.add(name.trim())
  try {
    const parsed = JSON.parse(aliasesJson || '[]') as unknown
    if (Array.isArray(parsed)) {
      for (const a of parsed) {
        const s = String(a).trim()
        if (s) aliases.add(s)
      }
    }
  } catch {
    /* ignore */
  }
  let n = 0
  for (const alias of aliases) {
    const norm = alias
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!norm) continue
    insert.run(randomUUID(), personId, alias, norm, now)
    n++
  }
  return n
}

/** Sincroniza tabla entity_aliases desde name + JSON aliases. */
export function syncPersonAliases(
  personId: string,
  name: string,
  aliasesJson: string,
): void {
  const database = getDb()
  const insert = database.prepare(`
    INSERT INTO entity_aliases (id, person_id, alias, alias_norm, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  syncPersonAliasesTx(
    database,
    insert,
    personId,
    name,
    aliasesJson,
    new Date().toISOString(),
  )
}

function syncProjectAliasesTx(
  database: DatabaseSync,
  insert: ReturnType<DatabaseSync['prepare']>,
  projectId: string,
  title: string,
  aliasesJson: string,
  now: string,
): number {
  database
    .prepare(`DELETE FROM project_aliases WHERE project_id = ?`)
    .run(projectId)
  const aliases = new Set<string>()
  aliases.add(title.trim())
  try {
    const parsed = JSON.parse(aliasesJson || '[]') as unknown
    if (Array.isArray(parsed)) {
      for (const a of parsed) {
        const s = String(a).trim()
        if (s) aliases.add(s)
      }
    }
  } catch {
    /* ignore */
  }
  let n = 0
  for (const alias of aliases) {
    const norm = alias
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!norm) continue
    insert.run(randomUUID(), projectId, alias, norm, now)
    n++
  }
  return n
}

/** Sincroniza tabla project_aliases desde title + JSON aliases. */
export function syncProjectAliases(
  projectId: string,
  title: string,
  aliasesJson: string,
): void {
  const database = getDb()
  const insert = database.prepare(`
    INSERT INTO project_aliases (id, project_id, alias, alias_norm, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  syncProjectAliasesTx(
    database,
    insert,
    projectId,
    title,
    aliasesJson,
    new Date().toISOString(),
  )
}

function seed(database: DatabaseSync): void {
  const existing = database
    .prepare('SELECT id FROM notebooks WHERE title = ?')
    .get('Trinchera') as { id: string } | undefined

  if (!existing) {
    database
      .prepare(
        'INSERT INTO notebooks (id, title, created_at) VALUES (?, ?, ?)',
      )
      .run(randomUUID(), 'Trinchera', new Date().toISOString())
  }
}

export function getTrincheraNotebookId(): string {
  const row = getDb()
    .prepare('SELECT id FROM notebooks WHERE title = ?')
    .get('Trinchera') as { id: string } | undefined
  if (!row) {
    throw new Error('Notebook "Trinchera" not found')
  }
  return row.id
}
