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

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function embedTexts(
  texts: string[],
  inputType: 'search_document' | 'search_query',
): Promise<{ model: string; vectors: number[][] } | null> {
  const apiKey = env('COHERE_API_KEY')
  const model = env('COHERE_EMBED_MODEL', 'embed-v4.0')
  if (!apiKey || texts.length === 0) return null

  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

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

  console.log(`[mnemosyne] embedded ${objectType}/${objectId} (${vector.length}d)`)
  return true
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

  const queryVec = result.vectors[0]
  const db = getDb()
  let embRows: EmbeddingRow[]
  if (types && types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    embRows = rows<EmbeddingRow>(
      db
        .prepare(
          `SELECT * FROM embeddings WHERE object_type IN (${placeholders}) AND model = ?`,
        )
        .all(...types, result.model),
    )
  } else {
    embRows = rows<EmbeddingRow>(
      db.prepare(`SELECT * FROM embeddings WHERE model = ?`).all(result.model),
    )
  }

  const scored = embRows
    .map((r) => {
      let vec: number[] = []
      try {
        vec = JSON.parse(r.vector) as number[]
      } catch {
        return null
      }
      return {
        object_type: r.object_type,
        object_id: r.object_id,
        score: cosineSimilarity(queryVec, vec),
      }
    })
    .filter(
      (r): r is { object_type: EmbeddingObjectType; object_id: string; score: number } =>
        r !== null,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return scored
}

/** Embed entry + sus quántomos reconocidos (post-Aduana). */
export async function embedApprovedEntry(entryId: string): Promise<void> {
  const db = getDb()
  const entry = row<{ id: string; title: string; content_raw: string | null }>(
    db.prepare(`SELECT id, title, content_raw FROM entries WHERE id = ?`).get(entryId),
  )
  if (!entry) return

  const entryText = [entry.title, entry.content_raw ?? ''].filter(Boolean).join('\n\n')
  await upsertEmbedding('entry', entry.id, entryText)

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
