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
import {
  matchesSourceAuthor,
  refinePersonKind,
} from './services/nerGuards.js'
import { normalizePersonKind } from './services/personKinds.js'
import { mapVisualSlot, TOTAL_FACES } from './services/notebookLayout.js'

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

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      author_name TEXT,
      author_username TEXT,
      created_at_source TEXT,
      link TEXT,
      media_urls TEXT NOT NULL DEFAULT '[]',
      weight INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDIENTE_CRIBA',
      category TEXT,
      extracted_entities TEXT NOT NULL DEFAULT '[]',
      suggested_links TEXT NOT NULL DEFAULT '[]',
      quantomo TEXT,
      entry_id TEXT,
      quantomo_id TEXT,
      imported_at TEXT NOT NULL
    );
  `)

  ensureColumn(database, 'entries', 'title_manual', 'INTEGER DEFAULT 0')
  ensureColumn(database, 'entries', 'original_filename', 'TEXT')
  ensureColumn(database, 'entries', 'batch_id', 'TEXT')
  ensureColumn(database, 'entries', 'parent_entry_id', 'TEXT')
  ensureColumn(database, 'entries', 'manual_tags', `TEXT NOT NULL DEFAULT '[]'`)
  ensureColumn(database, 'entries', 'operator_note', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(database, 'entries', 'human_weight', 'INTEGER')
  ensureColumn(database, 'entries', 'diarization_json', 'TEXT')
  ensureColumn(database, 'entries', 'speaker_map', `TEXT NOT NULL DEFAULT '[]'`)
  ensureColumn(database, 'entries', 'duration_sec', 'REAL')
  ensureColumn(database, 'persons', 'merged_into', 'TEXT')
  ensureColumn(database, 'persons', 'is_operator', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(database, 'projects', 'merged_into', 'TEXT')
  ensureColumn(database, 'projects', 'aliases', `TEXT NOT NULL DEFAULT '[]'`)
  ensureColumn(database, 'quantomos', 'human_weight', 'INTEGER')
  ensureColumn(database, 'quantomos', 'suggested_weight', 'INTEGER')

  // Cuadernos producto (físico/digital) — Trinchera = kind system
  ensureColumn(database, 'notebooks', 'kind', `TEXT NOT NULL DEFAULT 'system'`)
  ensureColumn(database, 'notebooks', 'cover_url', 'TEXT')
  ensureColumn(database, 'notebooks', 'total_sheets', 'INTEGER NOT NULL DEFAULT 80')
  ensureColumn(database, 'notebooks', 'total_faces', 'INTEGER NOT NULL DEFAULT 160')
  ensureColumn(
    database,
    'notebooks',
    'index_status',
    `TEXT NOT NULL DEFAULT 'vacio'`,
  )
  ensureColumn(
    database,
    'notebooks',
    'index_json',
    `TEXT NOT NULL DEFAULT '[]'`,
  )
  ensureColumn(database, 'notebooks', 'updated_at', 'TEXT')

  database.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL,
      slot_index INTEGER NOT NULL,
      numero_logico INTEGER NOT NULL,
      posicion_visual TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Vacia',
      image_path TEXT,
      title TEXT,
      transcription_spatial TEXT,
      graphic_elements TEXT NOT NULL DEFAULT '[]',
      is_blank INTEGER NOT NULL DEFAULT 0,
      entry_id TEXT,
      quantomo_id TEXT,
      explanation TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(notebook_id, slot_index)
    );
  `)

  ensureColumn(database, 'pages', 'vision_meta', 'TEXT')
  ensureColumn(
    database,
    'pages',
    'mentioned_entities',
    `TEXT NOT NULL DEFAULT '[]'`,
  )
  ensureColumn(database, 'pages', 'explanation_user', 'TEXT')
  remapaNotebookPageLayout(database)

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

    CREATE TABLE IF NOT EXISTS sandbox_graphs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sandbox_nodes (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT,
      label TEXT NOT NULL,
      color TEXT,
      notes TEXT NOT NULL DEFAULT '',
      fx REAL,
      fy REAL,
      fz REAL,
      created_at TEXT NOT NULL,
      UNIQUE(graph_id, kind, ref_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sandbox_nodes_graph
      ON sandbox_nodes(graph_id);

    CREATE TABLE IF NOT EXISTS sandbox_links (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual',
      label TEXT NOT NULL DEFAULT '',
      quantomo_id TEXT,
      promoted_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(graph_id, source_node_id, target_node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sandbox_links_graph
      ON sandbox_links(graph_id);

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      author_name TEXT,
      author_username TEXT,
      created_at_source TEXT,
      link TEXT,
      media_urls TEXT NOT NULL DEFAULT '[]',
      weight INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDIENTE_CRIBA',
      category TEXT,
      extracted_entities TEXT NOT NULL DEFAULT '[]',
      suggested_links TEXT NOT NULL DEFAULT '[]',
      quantomo TEXT,
      entry_id TEXT,
      quantomo_id TEXT,
      imported_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_status ON bookmarks(status);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_status_weight ON bookmarks(status, weight);

    CREATE TABLE IF NOT EXISTS agrupaciones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT,
      generated_meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agrupacion_members (
      id TEXT PRIMARY KEY,
      agrupacion_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(agrupacion_id, person_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agrupacion_members_agrupacion
      ON agrupacion_members(agrupacion_id);
    CREATE INDEX IF NOT EXISTS idx_agrupacion_members_person
      ON agrupacion_members(person_id);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      origin_hash TEXT NOT NULL UNIQUE,
      nombre_chat TEXT NOT NULL,
      tipo TEXT NOT NULL,
      participantes_json TEXT NOT NULL DEFAULT '[]',
      linked_person_ids_json TEXT NOT NULL DEFAULT '[]',
      vault_path TEXT,
      status TEXT NOT NULL DEFAULT 'parsed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      remitente TEXT,
      texto_crudo TEXT NOT NULL,
      timestamp_exact TEXT NOT NULL,
      is_system INTEGER NOT NULL DEFAULT 0,
      is_media INTEGER NOT NULL DEFAULT 0,
      estado_procesamiento TEXT NOT NULL DEFAULT 'pendiente',
      block_id TEXT,
      sort_index INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(chat_session_id, sort_index);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_block
      ON chat_messages(block_id);

    CREATE TABLE IF NOT EXISTS chat_blocks (
      id TEXT PRIMARY KEY,
      chat_session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      entry_id TEXT,
      quantomo_id TEXT,
      summary_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_chat_blocks_session
      ON chat_blocks(chat_session_id, started_at);

    CREATE TABLE IF NOT EXISTS link_harvest (
      id TEXT PRIMARY KEY,
      url_cruda TEXT NOT NULL,
      url_norm TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      remitente TEXT,
      timestamp_captura TEXT,
      chat_session_id TEXT,
      estado_crawler TEXT NOT NULL DEFAULT 'pendiente',
      created_at TEXT NOT NULL,
      UNIQUE(url_norm, source_type, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_link_harvest_norm ON link_harvest(url_norm);
    CREATE INDEX IF NOT EXISTS idx_link_harvest_estado
      ON link_harvest(estado_crawler);
    CREATE INDEX IF NOT EXISTS idx_link_harvest_source
      ON link_harvest(source_type, source_id);

    CREATE TABLE IF NOT EXISTS feedback_notes (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      view_id TEXT,
      body TEXT NOT NULL DEFAULT '',
      context_json TEXT NOT NULL DEFAULT '{}',
      logs_json TEXT NOT NULL DEFAULT '[]',
      images_json TEXT NOT NULL DEFAULT '[]',
      folder_path TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_notes_created
      ON feedback_notes(created_at DESC);
  `)
  ensureColumn(database, 'bookmarks', 'source', `TEXT NOT NULL DEFAULT 'twitter'`)
  ensureColumn(database, 'bookmarks', 'shortcode', 'TEXT')
  ensureColumn(database, 'bookmarks', 'media_pk', 'TEXT')
  ensureColumn(database, 'bookmarks', 'likes', 'INTEGER')
  ensureColumn(database, 'bookmarks', 'comments', 'INTEGER')
  ensureColumn(database, 'bookmarks', 'local_media_path', 'TEXT')
  ensureColumn(database, 'bookmarks', 'transcript', 'TEXT')
  ensureColumn(database, 'bookmarks', 'ocr_json', `TEXT NOT NULL DEFAULT '[]'`)
  ensureColumn(database, 'bookmarks', 'enrichment_json', `TEXT NOT NULL DEFAULT '{}'`)
  ensureColumn(database, 'bookmarks', 'operator_note', `TEXT NOT NULL DEFAULT ''`)
  ensureColumn(database, 'bookmarks', 'manual_tags', `TEXT NOT NULL DEFAULT '[]'`)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_source ON bookmarks(source);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_source_status ON bookmarks(source, status);
  `)
  backfillOriginalFilenames(database)
  backfillValidatedFileMetadata(database)
  backfillUnclearTimestamps(database)
  backfillQuantomoSuggestedWeights(database)
  migratePersonKinds(database)
  scrubBookmarkAuthorEntities(database)
  refinePendingPersonKinds(database)
  migrateProjectKinds(database)
  ensureEntityAliasIndex(database)
  ensureProjectAliasIndex(database)
  ensureEntityLinksIndex(database)
  backfillEntityAliases(database)
  backfillProjectAliases(database)
  ensureSearchFts(database)
}

/** Quantomos existentes: el peso Cohere/Aduana pasa a suggested_weight. */
function backfillQuantomoSuggestedWeights(database: DatabaseSync): void {
  database
    .prepare(
      `UPDATE quantomos
       SET suggested_weight = hermetic_weight
       WHERE suggested_weight IS NULL AND hermetic_weight IS NOT NULL`,
    )
    .run()
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

/** Corrige numeración: tapa ≠ página 1; contenido 1..80 según mapVisualSlot. */
function remapaNotebookPageLayout(database: DatabaseSync): void {
  const hasPages = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='pages'`,
    )
    .get() as { name: string } | undefined
  if (!hasPages) return

  const sample = database
    .prepare(
      `SELECT posicion_visual, numero_logico FROM pages WHERE slot_index = 0 LIMIT 1`,
    )
    .get() as { posicion_visual: string; numero_logico: number } | undefined

  // Ya migrado si slot 0 es Tapa con numero 0
  if (
    sample &&
    sample.posicion_visual === 'Tapa' &&
    sample.numero_logico === 0
  ) {
    return
  }
  // Si no hay páginas, nada
  if (!sample) {
    // puede haber notebooks sin pages aún; igual intentar update masivo
  }

  const upd = database.prepare(
    `UPDATE pages SET numero_logico = ?, posicion_visual = ? WHERE slot_index = ?`,
  )
  database.exec('BEGIN')
  try {
    for (let slot = 0; slot < TOTAL_FACES; slot++) {
      const m = mapVisualSlot(slot)
      upd.run(m.numero_logico, m.posicion_visual, slot)
    }
    // Legacy ImpactoTapa suelto
    database
      .prepare(
        `UPDATE pages SET posicion_visual = 'Tapa', numero_logico = 0
         WHERE posicion_visual = 'ImpactoTapa' AND slot_index = 0`,
      )
      .run()
    database.exec('COMMIT')
    console.log('[db] remapeo layout cuadernos: tapa ≠ página 1')
  } catch (err) {
    database.exec('ROLLBACK')
    console.error('[db] remapeo layout falló:', err)
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
       WHERE status IN ('queued', 'processing', 'pending_criba', 'pending_extract', 'pending_review')`,
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

/**
 * Quita autores de tweets/reels de propuestas NER, raw entities y sala de espera.
 * Idempotente: solo toca menciones que matchean author_name / author_username del bookmark.
 *
 * También resuelve entries huérfanas (source bookmark/instagram sin bookmarks.entry_id)
 * vía original_filename / link (p.ej. https://x.com/user/status/ID).
 */
function scrubBookmarkAuthorEntities(database: DatabaseSync): void {
  type AuthorRef = {
    entry_id: string
    author_name: string | null
    author_username: string | null
    bookmark_id: string | null
    extracted_entities: string | null
  }

  const byEntry = new Map<string, AuthorRef>()

  const addRef = (ref: AuthorRef) => {
    if (!ref.entry_id) return
    if (!ref.author_name && !ref.author_username) return
    // Prefer refs that also have bookmark snapshot data
    const prev = byEntry.get(ref.entry_id)
    if (!prev || (ref.bookmark_id && !prev.bookmark_id)) {
      byEntry.set(ref.entry_id, ref)
    }
  }

  const linked = database
    .prepare(
      `SELECT id, entry_id, author_name, author_username, extracted_entities
       FROM bookmarks
       WHERE entry_id IS NOT NULL
         AND (
           (author_name IS NOT NULL AND trim(author_name) != '')
           OR (author_username IS NOT NULL AND trim(author_username) != '')
         )`,
    )
    .all() as Array<{
    id: string
    entry_id: string
    author_name: string | null
    author_username: string | null
    extracted_entities: string
  }>

  for (const bm of linked) {
    addRef({
      entry_id: bm.entry_id,
      author_name: bm.author_name,
      author_username: bm.author_username,
      bookmark_id: bm.id,
      extracted_entities: bm.extracted_entities,
    })
  }

  // Huérfanos: entry bookmark/ig cuyo original_filename o content apunta al status
  const orphans = database
    .prepare(
      `SELECT e.id AS entry_id, e.original_filename, e.content_raw
       FROM entries e
       WHERE e.source_type IN ('bookmark', 'instagram')
         AND NOT EXISTS (SELECT 1 FROM bookmarks b WHERE b.entry_id = e.id)`,
    )
    .all() as Array<{
    entry_id: string
    original_filename: string | null
    content_raw: string | null
  }>

  const findBookmark = database.prepare(
    `SELECT id, author_name, author_username, extracted_entities
     FROM bookmarks WHERE id = ? OR link = ? LIMIT 1`,
  )

  for (const orphan of orphans) {
    const filename = String(orphan.original_filename ?? '')
    const statusId =
      filename.match(/status\/(\d+)/)?.[1] ||
      filename.match(/(?:^|[^\d])(\d{15,20})(?:$|[^\d])/)?.[1] ||
      null
    const handleFromUrl =
      filename.match(/(?:x\.com|twitter\.com|instagram\.com)\/([^/?#]+)/i)?.[1] ||
      null

    let authorName: string | null = null
    let authorUsername: string | null =
      handleFromUrl &&
      !['status', 'p', 'reel', 'i', 'stories'].includes(handleFromUrl.toLowerCase())
        ? handleFromUrl.replace(/^@/, '')
        : null
    let bookmarkId: string | null = null
    let extracted: string | null = null

    if (statusId) {
      const bm = findBookmark.get(statusId, filename) as
        | {
            id: string
            author_name: string | null
            author_username: string | null
            extracted_entities: string
          }
        | undefined
      if (bm) {
        bookmarkId = bm.id
        authorName = bm.author_name
        authorUsername = bm.author_username || authorUsername
        extracted = bm.extracted_entities
      }
    }

    addRef({
      entry_id: orphan.entry_id,
      author_name: authorName,
      author_username: authorUsername,
      bookmark_id: bookmarkId,
      extracted_entities: extracted,
    })
  }

  if (byEntry.size === 0) return

  const now = new Date().toISOString()
  const rejectProposal = database.prepare(
    `UPDATE entity_proposals
     SET status = 'rejected', resolved_at = ?
     WHERE id = ? AND status = 'pending'`,
  )
  const deleteRaw = database.prepare(
    `DELETE FROM entry_entities_raw WHERE id = ?`,
  )
  const updateExtracted = database.prepare(
    `UPDATE bookmarks SET extracted_entities = ? WHERE id = ?`,
  )
  const deleteLink = database.prepare(`DELETE FROM entity_links WHERE id = ?`)
  const deleteAlias = database.prepare(
    `DELETE FROM entity_aliases WHERE person_id = ?`,
  )
  const deletePerson = database.prepare(`DELETE FROM persons WHERE id = ?`)

  let rejected = 0
  let rawDeleted = 0
  let extractedUpdated = 0
  let linksRemoved = 0
  let waitingRemoved = 0
  const scrubbedSnapshots = new Set<string>()

  for (const bm of byEntry.values()) {
    const proposals = database
      .prepare(
        `SELECT id, suggested_name FROM entity_proposals
         WHERE entry_id = ? AND kind = 'person' AND status = 'pending'`,
      )
      .all(bm.entry_id) as Array<{ id: string; suggested_name: string }>

    for (const p of proposals) {
      if (
        matchesSourceAuthor(p.suggested_name, bm.author_name, bm.author_username)
      ) {
        rejectProposal.run(now, p.id)
        rejected++
      }
    }

    const raws = database
      .prepare(
        `SELECT id, name FROM entry_entities_raw WHERE entry_id = ?`,
      )
      .all(bm.entry_id) as Array<{ id: string; name: string }>

    for (const r of raws) {
      if (matchesSourceAuthor(r.name, bm.author_name, bm.author_username)) {
        deleteRaw.run(r.id)
        rawDeleted++
      }
    }

    if (bm.bookmark_id && bm.extracted_entities && !scrubbedSnapshots.has(bm.bookmark_id)) {
      try {
        const parsed = JSON.parse(bm.extracted_entities || '[]') as unknown
        if (Array.isArray(parsed)) {
          const next = parsed.filter((e) => {
            const name =
              e && typeof e === 'object' && 'name' in e
                ? String((e as { name: unknown }).name ?? '')
                : ''
            return !matchesSourceAuthor(
              name,
              bm.author_name,
              bm.author_username,
            )
          })
          if (next.length !== parsed.length) {
            updateExtracted.run(JSON.stringify(next), bm.bookmark_id)
            extractedUpdated++
          }
        }
      } catch {
        /* ignore */
      }
      scrubbedSnapshots.add(bm.bookmark_id)
    }

    const links = database
      .prepare(
        `SELECT l.id AS link_id, l.entity_id AS person_id, p.name AS person_name
         FROM entity_links l
         JOIN persons p ON p.id = l.entity_id
         WHERE l.entry_id = ? AND l.entity_kind = 'person'`,
      )
      .all(bm.entry_id) as Array<{
      link_id: string
      person_id: string
      person_name: string
    }>

    for (const link of links) {
      if (
        !matchesSourceAuthor(
          link.person_name,
          bm.author_name,
          bm.author_username,
        )
      ) {
        continue
      }
      deleteLink.run(link.link_id)
      linksRemoved++
    }
  }

  const waiting = database
    .prepare(
      `SELECT p.id, p.name FROM persons p
       WHERE p.source = 'extractor'
         AND (p.merged_into IS NULL OR p.merged_into = '')
         AND NOT EXISTS (
           SELECT 1 FROM entity_links l
           WHERE l.entity_kind = 'person' AND l.entity_id = p.id
         )`,
    )
    .all() as Array<{ id: string; name: string }>

  const authorBookmarks = database
    .prepare(
      `SELECT author_name, author_username FROM bookmarks
       WHERE (author_name IS NOT NULL AND trim(author_name) != '')
          OR (author_username IS NOT NULL AND trim(author_username) != '')`,
    )
    .all() as Array<{
    author_name: string | null
    author_username: string | null
  }>

  for (const person of waiting) {
    const isAuthor = authorBookmarks.some((a) =>
      matchesSourceAuthor(person.name, a.author_name, a.author_username),
    )
    if (!isAuthor) continue
    deleteAlias.run(person.id)
    deletePerson.run(person.id)
    waitingRemoved++
  }

  if (
    rejected > 0 ||
    rawDeleted > 0 ||
    extractedUpdated > 0 ||
    linksRemoved > 0 ||
    waitingRemoved > 0
  ) {
    console.log(
      `[db] scrub bookmark authors: proposals=${rejected} raw=${rawDeleted} snapshots=${extractedUpdated} links=${linksRemoved} waiting=${waitingRemoved}`,
    )
  }
}

/** Refina kind fisica→juridica/ficticia en propuestas pending y personas extractor. */
function refinePendingPersonKinds(database: DatabaseSync): void {
  const pending = database
    .prepare(
      `SELECT id, suggested_name, suggested_meta FROM entity_proposals
       WHERE kind = 'person' AND status = 'pending'`,
    )
    .all() as Array<{
    id: string
    suggested_name: string
    suggested_meta: string
  }>
  const updProp = database.prepare(
    `UPDATE entity_proposals SET suggested_meta = ? WHERE id = ?`,
  )
  let props = 0
  for (const row of pending) {
    try {
      const meta = JSON.parse(row.suggested_meta || '{}') as Record<
        string,
        unknown
      >
      const current = normalizePersonKind(meta.kind)
      const next = refinePersonKind(row.suggested_name, current)
      if (next !== current) {
        meta.kind = next
        updProp.run(JSON.stringify(meta), row.id)
        props++
      }
    } catch {
      /* ignore */
    }
  }

  const persons = database
    .prepare(
      `SELECT id, name, kind FROM persons
       WHERE source = 'extractor'
         AND (merged_into IS NULL OR merged_into = '')`,
    )
    .all() as Array<{ id: string; name: string; kind: string }>
  const updPerson = database.prepare(
    `UPDATE persons SET kind = ?, updated_at = ? WHERE id = ?`,
  )
  const now = new Date().toISOString()
  let personsN = 0
  for (const p of persons) {
    const current = normalizePersonKind(p.kind)
    const next = refinePersonKind(p.name, current)
    if (next !== current) {
      updPerson.run(next, now, p.id)
      personsN++
    }
  }

  // También payload en entry_entities_raw
  const raws = database
    .prepare(
      `SELECT id, name, payload FROM entry_entities_raw
       WHERE type IN ('person','persona','people','fisica','juridica','ficticia','ficticio','abstracta','ruido','agrupacion')`,
    )
    .all() as Array<{ id: string; name: string; payload: string }>
  const updRaw = database.prepare(
    `UPDATE entry_entities_raw SET payload = ? WHERE id = ?`,
  )
  let rawN = 0
  for (const r of raws) {
    try {
      const payload = JSON.parse(r.payload || '{}') as Record<string, unknown>
      const current = normalizePersonKind(payload.kind)
      const next = refinePersonKind(r.name, current)
      if (next !== current) {
        payload.kind = next
        updRaw.run(JSON.stringify(payload), r.id)
        rawN++
      }
    } catch {
      /* ignore */
    }
  }

  if (props > 0 || personsN > 0 || rawN > 0) {
    console.log(
      `[db] refine person kinds: proposals=${props} waiting=${personsN} raw=${rawN}`,
    )
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

function normalizeAliasKey(alias: string): string {
  return alias
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Dedupa por alias_norm (Odín / Odin → una sola fila). */
function collectAliasRows(
  canonical: string,
  aliasesJson: string,
): Array<{ alias: string; norm: string }> {
  const byNorm = new Map<string, string>()
  const add = (raw: string) => {
    const alias = raw.trim()
    if (!alias) return
    const norm = normalizeAliasKey(alias)
    if (!norm) return
    if (!byNorm.has(norm)) byNorm.set(norm, alias)
  }
  add(canonical)
  try {
    const parsed = JSON.parse(aliasesJson || '[]') as unknown
    if (Array.isArray(parsed)) {
      for (const a of parsed) add(String(a))
    }
  } catch {
    /* ignore */
  }
  return [...byNorm.entries()].map(([norm, alias]) => ({ alias, norm }))
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
  let n = 0
  for (const { alias, norm } of collectAliasRows(name, aliasesJson)) {
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
  upsertPersonFts(database, personId, name, aliasesJson)
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
  let n = 0
  for (const { alias, norm } of collectAliasRows(title, aliasesJson)) {
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
  upsertProjectFts(database, projectId, title, aliasesJson)
}

export function removePersonFts(personId: string): void {
  getDb().prepare(`DELETE FROM persons_fts WHERE person_id = ?`).run(personId)
}

export function removeProjectFts(projectId: string): void {
  getDb().prepare(`DELETE FROM projects_fts WHERE project_id = ?`).run(projectId)
}

export function upsertQuantomoFts(
  quantomoId: string,
  title: string,
  content: string | null | undefined,
): void {
  const database = getDb()
  const body = (content ?? '').replace(/\s+/g, ' ').trim().slice(0, 800)
  database.prepare(`DELETE FROM quantomos_fts WHERE quantomo_id = ?`).run(quantomoId)
  database
    .prepare(
      `INSERT INTO quantomos_fts (quantomo_id, title, body) VALUES (?, ?, ?)`,
    )
    .run(quantomoId, title, body)
}

export function removeQuantomoFts(quantomoId: string): void {
  getDb().prepare(`DELETE FROM quantomos_fts WHERE quantomo_id = ?`).run(quantomoId)
}

function aliasesJsonToFtsText(aliasesJson: string): string {
  try {
    const parsed = JSON.parse(aliasesJson || '[]') as unknown
    if (Array.isArray(parsed)) {
      return parsed.map((a) => String(a).trim()).filter(Boolean).join(' ')
    }
  } catch {
    /* ignore */
  }
  return ''
}

function upsertPersonFts(
  database: DatabaseSync,
  personId: string,
  name: string,
  aliasesJson: string,
): void {
  database.prepare(`DELETE FROM persons_fts WHERE person_id = ?`).run(personId)
  database
    .prepare(
      `INSERT INTO persons_fts (person_id, name, aliases) VALUES (?, ?, ?)`,
    )
    .run(personId, name, aliasesJsonToFtsText(aliasesJson))
}

function upsertProjectFts(
  database: DatabaseSync,
  projectId: string,
  title: string,
  aliasesJson: string,
): void {
  database.prepare(`DELETE FROM projects_fts WHERE project_id = ?`).run(projectId)
  database
    .prepare(
      `INSERT INTO projects_fts (project_id, title, aliases) VALUES (?, ?, ?)`,
    )
    .run(projectId, title, aliasesJsonToFtsText(aliasesJson))
}

/** FTS5 léxico para typeahead inmediato (sin Cohere). */
function ensureSearchFts(database: DatabaseSync): void {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persons_fts USING fts5(
      person_id UNINDEXED,
      name,
      aliases,
      tokenize = 'unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
      project_id UNINDEXED,
      title,
      aliases,
      tokenize = 'unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS quantomos_fts USING fts5(
      quantomo_id UNINDEXED,
      title,
      body,
      tokenize = 'unicode61'
    );
  `)

  // Triggers solo para quántomos (personas/proyectos se sincronizan vía sync*Aliases).
  database.exec(`
    DROP TRIGGER IF EXISTS quantomos_fts_ai;
    DROP TRIGGER IF EXISTS quantomos_fts_au;
    DROP TRIGGER IF EXISTS quantomos_fts_ad;
    CREATE TRIGGER quantomos_fts_ai AFTER INSERT ON quantomos BEGIN
      INSERT INTO quantomos_fts(quantomo_id, title, body)
      VALUES (
        new.id,
        new.title,
        substr(replace(coalesce(new.content, ''), char(10), ' '), 1, 800)
      );
    END;
    CREATE TRIGGER quantomos_fts_au AFTER UPDATE OF title, content ON quantomos BEGIN
      DELETE FROM quantomos_fts WHERE quantomo_id = old.id;
      INSERT INTO quantomos_fts(quantomo_id, title, body)
      VALUES (
        new.id,
        new.title,
        substr(replace(coalesce(new.content, ''), char(10), ' '), 1, 800)
      );
    END;
    CREATE TRIGGER quantomos_fts_ad AFTER DELETE ON quantomos BEGIN
      DELETE FROM quantomos_fts WHERE quantomo_id = old.id;
    END;
  `)

  backfillSearchFts(database)
}

export function rebuildSearchFts(database: DatabaseSync = getDb()): void {
  database.exec(`DELETE FROM persons_fts`)
  const persons = database
    .prepare(`SELECT id, name, aliases FROM persons`)
    .all() as Array<{ id: string; name: string; aliases: string }>
  for (const p of persons) {
    upsertPersonFts(database, p.id, p.name, p.aliases || '[]')
  }

  database.exec(`DELETE FROM projects_fts`)
  const projects = database
    .prepare(`SELECT id, title, aliases FROM projects`)
    .all() as Array<{ id: string; title: string; aliases: string | null }>
  for (const p of projects) {
    upsertProjectFts(database, p.id, p.title, p.aliases || '[]')
  }

  database.exec(`DELETE FROM quantomos_fts`)
  database.exec(`
    INSERT INTO quantomos_fts(quantomo_id, title, body)
    SELECT
      id,
      title,
      substr(replace(coalesce(content, ''), char(10), ' '), 1, 800)
    FROM quantomos
  `)
}

export function ensureTrincheraSeed(): void {
  seed(getDb())
}

function backfillSearchFts(database: DatabaseSync): void {
  const personFts = database
    .prepare(`SELECT COUNT(*) as c FROM persons_fts`)
    .get() as { c: number }
  const personCount = database
    .prepare(`SELECT COUNT(*) as c FROM persons`)
    .get() as { c: number }
  if (personFts.c === 0 && personCount.c > 0) {
    const persons = database
      .prepare(`SELECT id, name, aliases FROM persons`)
      .all() as Array<{ id: string; name: string; aliases: string }>
    database.exec('BEGIN')
    try {
      for (const p of persons) {
        upsertPersonFts(database, p.id, p.name, p.aliases || '[]')
      }
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
    console.log(`[db] backfill persons_fts (${persons.length})`)
  }

  const projectFts = database
    .prepare(`SELECT COUNT(*) as c FROM projects_fts`)
    .get() as { c: number }
  const projectCount = database
    .prepare(`SELECT COUNT(*) as c FROM projects`)
    .get() as { c: number }
  if (projectFts.c === 0 && projectCount.c > 0) {
    const projects = database
      .prepare(`SELECT id, title, aliases FROM projects`)
      .all() as Array<{ id: string; title: string; aliases: string | null }>
    database.exec('BEGIN')
    try {
      for (const p of projects) {
        upsertProjectFts(database, p.id, p.title, p.aliases || '[]')
      }
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
    console.log(`[db] backfill projects_fts (${projects.length})`)
  }

  const quantomoFts = database
    .prepare(`SELECT COUNT(*) as c FROM quantomos_fts`)
    .get() as { c: number }
  const quantomoCount = database
    .prepare(`SELECT COUNT(*) as c FROM quantomos`)
    .get() as { c: number }
  if (quantomoFts.c === 0 && quantomoCount.c > 0) {
    database.exec(`
      INSERT INTO quantomos_fts(quantomo_id, title, body)
      SELECT
        id,
        title,
        substr(replace(coalesce(content, ''), char(10), ' '), 1, 800)
      FROM quantomos
    `)
    console.log(`[db] backfill quantomos_fts (${quantomoCount.c})`)
  }
}

function seed(database: DatabaseSync): void {
  const now = new Date().toISOString()
  const existing = database
    .prepare('SELECT id FROM notebooks WHERE title = ?')
    .get('Trinchera') as { id: string } | undefined

  if (!existing) {
    database
      .prepare(
        `INSERT INTO notebooks (
          id, title, created_at, kind, cover_url, total_sheets, total_faces,
          index_status, index_json, updated_at
        ) VALUES (?, ?, ?, 'system', NULL, 80, 160, 'vacio', '[]', ?)`,
      )
      .run(randomUUID(), 'Trinchera', now, now)
  } else {
    database
      .prepare(
        `UPDATE notebooks SET kind = 'system', updated_at = COALESCE(updated_at, ?)
         WHERE title = 'Trinchera'`,
      )
      .run(now)
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
