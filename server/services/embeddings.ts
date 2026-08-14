/**
 * Mnemosyne — memoria semántica local-first.
 * Embeddings via Cohere Embed v4, persistidos en SQLite + cosine search.
 */
import { createHash, randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { row, rows } from '../sql.js'
import type { EmbeddingObjectType, EmbeddingRow } from '../types.js'

function env(key: string, fallback = ''): string {
  return process.env[key]?.replace(/^["']|["']$/g, '') ?? fallback
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

type CachedVec = {
  object_type: EmbeddingObjectType
  object_id: string
  vector: Float32Array
}

/** Caché en proceso: evita JSON.parse de todos los vectores por query. */
const vectorCache = new Map<string, CachedVec[]>()

function cacheKey(model: string, types?: EmbeddingObjectType[]): string {
  const t = types?.length ? [...types].sort().join(',') : '*'
  return `${model}::${t}`
}

function invalidateVectorCache(): void {
  vectorCache.clear()
}

function parseVector(raw: string): Float32Array | null {
  try {
    const arr = JSON.parse(raw) as number[]
    if (!Array.isArray(arr) || arr.length === 0) return null
    return Float32Array.from(arr)
  } catch {
    return null
  }
}

function loadVectorPartition(
  model: string,
  types?: EmbeddingObjectType[],
): CachedVec[] {
  const key = cacheKey(model, types)
  const hit = vectorCache.get(key)
  if (hit) return hit

  const db = getDb()
  let embRows: EmbeddingRow[]
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    embRows = rows<EmbeddingRow>(
      db
        .prepare(
          `SELECT * FROM embeddings WHERE object_type IN (${placeholders}) AND model = ?`,
        )
        .all(...types, model),
    )
  } else {
    embRows = rows<EmbeddingRow>(
      db.prepare(`SELECT * FROM embeddings WHERE model = ?`).all(model),
    )
  }

  const cached: CachedVec[] = []
  for (const r of embRows) {
    const vector = parseVector(r.vector)
    if (!vector) continue
    cached.push({
      object_type: r.object_type,
      object_id: r.object_id,
      vector,
    })
  }
  vectorCache.set(key, cached)
  return cached
}

async function embedTexts(
  texts: string[],
  inputType: 'search_document' | 'search_query',
): Promise<{ model: string; vectors: number[][] } | null> {
  const apiKey = env('COHERE_API_KEY')
  const model = env('COHERE_EMBED_MODEL', 'embed-v4.0')
  if (!apiKey || texts.length === 0) return null

  // Delay solo para indexación/batch — nunca en search_query (typeahead/Ir).
  if (inputType === 'search_document') {
    const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
    if (delayMs > 0) await delay(delayMs)
  }

  try {
    const res = await fetch('https://api.cohere.com/v2/embed', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        texts,
        input_type: inputType,
        embedding_types: ['float'],
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[mnemosyne] embed API error:', res.status, errText)
      return null
    }

    const data = (await res.json()) as {
      embeddings?: { float?: number[][] }
      float?: number[][]
    }
    const vectors = data.embeddings?.float ?? data.float ?? []
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      console.error('[mnemosyne] unexpected embed response shape')
      return null
    }
    return { model, vectors }
  } catch (err) {
    console.error('[mnemosyne] embed failed:', err)
    return null
  }
}

export async function upsertEmbedding(
  objectType: EmbeddingObjectType,
  objectId: string,
  text: string,
): Promise<boolean> {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return false

  const textHash = hashText(cleaned)
  const db = getDb()
  const model = env('COHERE_EMBED_MODEL', 'embed-v4.0')

  const existing = row<{ id: string; text_hash: string }>(
    db
      .prepare(
        `SELECT id, text_hash FROM embeddings
       WHERE object_type = ? AND object_id = ? AND model = ?`,
      )
      .get(objectType, objectId, model),
  )

  if (existing?.text_hash === textHash) {
    return true
  }

  const result = await embedTexts([cleaned], 'search_document')
  if (!result || !result.vectors[0]) {
    console.warn(
      `[mnemosyne] skip embed ${objectType}/${objectId} (no API key or failure)`,
    )
    return false
  }

  const vector = result.vectors[0]
  const now = new Date().toISOString()

  if (existing) {
    db.prepare(
      `UPDATE embeddings SET dims = ?, vector = ?, text_hash = ?, created_at = ?
       WHERE id = ?`,
    ).run(vector.length, JSON.stringify(vector), textHash, now, existing.id)
  } else {
    db.prepare(
      `INSERT INTO embeddings (
        id, object_type, object_id, model, dims, vector, text_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      objectType,
      objectId,
      result.model,
      vector.length,
      JSON.stringify(vector),
      textHash,
      now,
    )
  }

  invalidateVectorCache()
  console.log(`[mnemosyne] embedded ${objectType}/${objectId} (${vector.length}d)`)
  return true
}

export function deleteEmbedding(
  objectType: EmbeddingObjectType,
  objectId: string,
): void {
  const db = getDb()
  db.prepare(
    `DELETE FROM embeddings WHERE object_type = ? AND object_id = ?`,
  ).run(objectType, objectId)
  invalidateVectorCache()
}

export async function searchSimilar(
  query: string,
  opts?: { types?: EmbeddingObjectType[]; limit?: number },
): Promise<
  Array<{
    object_type: EmbeddingObjectType
    object_id: string
    score: number
  }>
> {
  const limit = opts?.limit ?? 10
  const types = opts?.types
  const result = await embedTexts([query], 'search_query')
  if (!result || !result.vectors[0]) return []

  const queryVec = Float32Array.from(result.vectors[0])
  const partition = loadVectorPartition(result.model, types)

  const scored = partition
    .map((r) => ({
      object_type: r.object_type,
      object_id: r.object_id,
      score: cosineSimilarity(queryVec, r.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return scored
}

/** Parte texto largo en chunks con overlap para Embed v4. */
export function chunkForEmbed(
  text: string,
  maxChars = 1100,
  overlap = 140,
): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  if (clean.length <= maxChars) return [clean]

  const paras = clean.split(/\n\s*\n/)
  const packed: string[] = []
  let buf = ''
  for (const p of paras) {
    const next = buf ? `${buf}\n\n${p}` : p
    if (next.length > maxChars && buf) {
      packed.push(buf.trim())
      const tail = buf.slice(Math.max(0, buf.length - overlap))
      buf = `${tail}\n\n${p}`
    } else {
      buf = next
    }
  }
  if (buf.trim()) packed.push(buf.trim())

  const out: string[] = []
  const step = Math.max(maxChars - overlap, 200)
  for (const c of packed) {
    if (c.length <= maxChars) {
      out.push(c)
      continue
    }
    for (let i = 0; i < c.length; i += step) {
      out.push(c.slice(i, i + maxChars))
    }
  }
  return out
}

/** Embed entry + chunks + quántomos reconocidos (post-Aduana). */
export async function embedApprovedEntry(entryId: string): Promise<void> {
  const db = getDb()
  const entry = row<{ id: string; title: string; content_raw: string | null }>(
    db.prepare(`SELECT id, title, content_raw FROM entries WHERE id = ?`).get(entryId),
  )
  if (!entry) return

  const raw = entry.content_raw ?? ''
  const chunks = chunkForEmbed(raw)
  const head = [entry.title, chunks[0] ?? raw].filter(Boolean).join('\n\n')
  await upsertEmbedding('entry', entry.id, head)

  db.prepare(
    `DELETE FROM embeddings WHERE object_type = 'entry_chunk' AND object_id LIKE ?`,
  ).run(`${entry.id}:%`)

  if (chunks.length > 1) {
    for (let i = 0; i < chunks.length; i++) {
      await upsertEmbedding('entry_chunk', `${entry.id}:${i}`, chunks[i]!)
    }
  }

  const quantomos = rows<{ id: string; title: string; content: string | null }>(
    db
      .prepare(
        `SELECT id, title, content FROM quantomos WHERE entry_id = ? AND recognized = 1`,
      )
      .all(entryId),
  )

  for (const q of quantomos) {
    const text = [q.title, q.content ?? ''].filter(Boolean).join('\n')
    await upsertEmbedding('quantomo', q.id, text)
  }
}

export async function embedPerson(personId: string): Promise<void> {
  const db = getDb()
  const p = row<{
    id: string
    name: string
    kind: string
    aliases: string
    notes: string | null
  }>(db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId))
  if (!p) return
  let aliases: string[] = []
  try {
    aliases = JSON.parse(p.aliases) as string[]
  } catch {
    aliases = []
  }
  const text = [
    `Persona: ${p.name}`,
    `Tipo: ${p.kind}`,
    aliases.length ? `Alias: ${aliases.join(', ')}` : '',
    p.notes ?? '',
  ]
    .filter(Boolean)
    .join('\n')
  await upsertEmbedding('person', p.id, text)
}

export async function embedProject(projectId: string): Promise<void> {
  const db = getDb()
  const p = row<{
    id: string
    title: string
    category: string | null
    status: string
    tactical_focus: string | null
    notes: string | null
    aliases: string | null
  }>(db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId))
  if (!p) return
  let aliases: string[] = []
  try {
    aliases = JSON.parse(p.aliases || '[]') as string[]
  } catch {
    aliases = []
  }
  const text = [
    `Proyecto: ${p.title}`,
    p.category ? `Tipo: ${p.category}` : '',
    `Estado: ${p.status}`,
    aliases.length ? `Alias: ${aliases.join(', ')}` : '',
    p.tactical_focus ? `Enfoque: ${p.tactical_focus}` : '',
    p.notes ?? '',
  ]
    .filter(Boolean)
    .join('\n')
  await upsertEmbedding('project', p.id, text)
}

export async function embedLinkContext(
  linkId: string,
  entityKind: string,
  entityName: string,
  entryTitle: string,
  evidenceSnippet: string,
): Promise<void> {
  const text = [
    `Vínculo ${entityKind}: ${entityName}`,
    `Fuente: ${entryTitle}`,
    evidenceSnippet,
  ]
    .filter(Boolean)
    .join('\n')
  await upsertEmbedding('link_context', linkId, text)
}

/** Fire-and-forget wrapper para no bloquear HTTP. */
export function enqueueEmbed(fn: () => Promise<void>): void {
  void fn().catch((err) => {
    console.error('[mnemosyne] background embed error:', err)
  })
}
