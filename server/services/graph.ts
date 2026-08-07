/**
 * Grafo semántico — co-ocurrencia HITL + GraphRAG (Mastropiero context).
 */
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { rows, row } from '../sql.js'
import { cosineSimilarity, searchSimilar } from './embeddings.js'
import { getOperatorId } from './entityRelations.js'

/** Marca un par persona↔proyecto para no volver a sugerirlo (X o desvínculo). */
export function dismissGraphLinkSuggestion(
  personId: string,
  projectId: string,
): { ok: boolean; created: boolean } {
  const db = getDb()
  const pid = personId.trim()
  const proj = projectId.trim()
  if (!pid || !proj) return { ok: false, created: false }

  const existing = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM graph_link_dismissals
         WHERE person_id = ? AND project_id = ?`,
      )
      .get(pid, proj),
  )
  if (existing) return { ok: true, created: false }

  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO graph_link_dismissals (id, person_id, project_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(randomUUID(), pid, proj, now)
  return { ok: true, created: true }
}

export interface GraphLinkSuggestion {
  person_id: string
  person_name: string
  project_id: string
  project_title: string
  shared_entry_count: number
  weight: number
  shared_entry_ids: string[]
  suggested_role: 'co_mentioned'
}

export interface DiscoverLinksOpts {
  person_id?: string
  project_id?: string
  limit?: number
}

/**
 * Co-ocurrencia fuerte: persona y proyecto mencionados en la misma entry
 * (entity_links) y aún no vinculados en person_project_links.
 */
export function discoverLinks(
  opts: DiscoverLinksOpts = {},
): GraphLinkSuggestion[] {
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const personFilter = opts.person_id?.trim() || null
  const projectFilter = opts.project_id?.trim() || null

  const params: string[] = []
  let filterSql = ''
  if (personFilter) {
    filterSql += ' AND pe.entity_id = ?'
    params.push(personFilter)
  }
  if (projectFilter) {
    filterSql += ' AND pr.entity_id = ?'
    params.push(projectFilter)
  }

  const raw = rows<{
    person_id: string
    person_name: string
    project_id: string
    project_title: string
    shared_entry_count: number
    entry_ids_csv: string
  }>(
    db
      .prepare(
        `
      SELECT
        pe.entity_id AS person_id,
        p.name AS person_name,
        pr.entity_id AS project_id,
        proj.title AS project_title,
        COUNT(DISTINCT pe.entry_id) AS shared_entry_count,
        GROUP_CONCAT(DISTINCT pe.entry_id) AS entry_ids_csv
      FROM entity_links pe
      INNER JOIN entity_links pr
        ON pr.entry_id = pe.entry_id
       AND pr.entity_kind = 'project'
      INNER JOIN persons p
        ON p.id = pe.entity_id
       AND (p.merged_into IS NULL OR p.merged_into = '')
      INNER JOIN projects proj
        ON proj.id = pr.entity_id
       AND (proj.merged_into IS NULL OR proj.merged_into = '')
      LEFT JOIN person_project_links pp
        ON pp.person_id = pe.entity_id
       AND pp.project_id = pr.entity_id
      LEFT JOIN graph_link_dismissals gd
        ON gd.person_id = pe.entity_id
       AND gd.project_id = pr.entity_id
      WHERE pe.entity_kind = 'person'
        AND pp.id IS NULL
        AND gd.id IS NULL
        ${filterSql}
      GROUP BY pe.entity_id, pr.entity_id
      ORDER BY shared_entry_count DESC, p.name COLLATE NOCASE, proj.title COLLATE NOCASE
      LIMIT ?
      `,
      )
      .all(...params, limit),
  )

  return raw.map((r) => {
    const ids = (r.entry_ids_csv || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const unique = [...new Set(ids)].slice(0, 5)
    return {
      person_id: r.person_id,
      person_name: r.person_name,
      project_id: r.project_id,
      project_title: r.project_title,
      shared_entry_count: Number(r.shared_entry_count) || 0,
      weight: Number(r.shared_entry_count) || 0,
      shared_entry_ids: unique,
      suggested_role: 'co_mentioned' as const,
    }
  })
}

function hydrateSeed(
  objectType: string,
  objectId: string,
  score: number,
): { label: string; snippet: string; score: number; type: string; id: string } | null {
  const db = getDb()
  if (objectType === 'person') {
    const p = row<{ name: string; notes: string | null }>(
      db
        .prepare(
          `SELECT name, notes FROM persons
           WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
        )
        .get(objectId),
    )
    if (!p) return null
    return {
      type: 'person',
      id: objectId,
      label: p.name,
      snippet: (p.notes ?? '').slice(0, 160),
      score,
    }
  }
  if (objectType === 'project') {
    const p = row<{
      title: string
      tactical_focus: string | null
      notes: string | null
    }>(
      db
        .prepare(
          `SELECT title, tactical_focus, notes FROM projects
           WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
        )
        .get(objectId),
    )
    if (!p) return null
    const snippet = [p.tactical_focus, p.notes].filter(Boolean).join(' — ').slice(0, 160)
    return {
      type: 'project',
      id: objectId,
      label: p.title,
      snippet,
      score,
    }
  }
  if (objectType === 'quantomo') {
    const q = row<{
      title: string
      content: string | null
      entry_id: string
    }>(
      db
        .prepare(`SELECT title, content, entry_id FROM quantomos WHERE id = ?`)
        .get(objectId),
    )
    if (!q) return null
    return {
      type: 'quantomo',
      id: objectId,
      label: q.title,
      snippet: (q.content ?? '').slice(0, 160),
      score,
    }
  }
  return null
}

interface NeighborLine {
  type: string
  id: string
  label: string
  via: string
}

function neighborsForPerson(personId: string): NeighborLine[] {
  const db = getDb()
  return rows<{ id: string; title: string; role: string }>(
    db
      .prepare(
        `
      SELECT proj.id, proj.title, pp.role
      FROM person_project_links pp
      INNER JOIN projects proj ON proj.id = pp.project_id
      WHERE pp.person_id = ?
        AND (proj.merged_into IS NULL OR proj.merged_into = '')
      `,
      )
      .all(personId),
  ).map((r) => ({
    type: 'project',
    id: r.id,
    label: r.title,
    via: `person_project_links:${r.role}`,
  }))
}

function neighborsForProject(projectId: string): NeighborLine[] {
  const db = getDb()
  return rows<{ id: string; name: string; role: string }>(
    db
      .prepare(
        `
      SELECT p.id, p.name, pp.role
      FROM person_project_links pp
      INNER JOIN persons p ON p.id = pp.person_id
      WHERE pp.project_id = ?
        AND (p.merged_into IS NULL OR p.merged_into = '')
      `,
      )
      .all(projectId),
  ).map((r) => ({
    type: 'person',
    id: r.id,
    label: r.name,
    via: `person_project_links:${r.role}`,
  }))
}

function neighborsForQuantomo(quantomoId: string): NeighborLine[] {
  const db = getDb()
  const q = row<{ entry_id: string; entry_title: string }>(
    db
      .prepare(
        `
      SELECT q.entry_id, e.title AS entry_title
      FROM quantomos q
      INNER JOIN entries e ON e.id = q.entry_id
      WHERE q.id = ?
      `,
      )
      .get(quantomoId),
  )
  if (!q) return []

  const out: NeighborLine[] = [
    {
      type: 'entry',
      id: q.entry_id,
      label: q.entry_title,
      via: 'quantomo.entry_id',
    },
  ]

  const linked = rows<{
    entity_kind: string
    entity_id: string
    name: string
  }>(
    db
      .prepare(
        `
      SELECT
        l.entity_kind,
        l.entity_id,
        CASE
          WHEN l.entity_kind = 'person' THEN p.name
          WHEN l.entity_kind = 'project' THEN proj.title
          ELSE l.entity_id
        END AS name
      FROM entity_links l
      LEFT JOIN persons p
        ON l.entity_kind = 'person' AND p.id = l.entity_id
       AND (p.merged_into IS NULL OR p.merged_into = '')
      LEFT JOIN projects proj
        ON l.entity_kind = 'project' AND proj.id = l.entity_id
       AND (proj.merged_into IS NULL OR proj.merged_into = '')
      WHERE l.entry_id = ?
        AND l.entity_kind IN ('person', 'project')
      `,
      )
      .all(q.entry_id),
  )

  for (const l of linked) {
    if (!l.name) continue
    out.push({
      type: l.entity_kind,
      id: l.entity_id,
      label: l.name,
      via: `entity_links:${q.entry_id}`,
    })
  }
  return out
}

/**
 * GraphRAG core: top-3 nodos semánticos + vecinos 1-hop → string para prompt.
 */
export async function searchGraphContext(query: string): Promise<string> {
  const q = query.trim()
  if (!q) {
    return '## Seeds\n(sin query)\n\n## Neighbors\n(ninguno)'
  }

  const hits = await searchSimilar(q, {
    types: ['person', 'project', 'quantomo'],
    limit: 3,
  })

  const seeds = hits
    .map((h) => hydrateSeed(h.object_type, h.object_id, h.score))
    .filter((s): s is NonNullable<typeof s> => s !== null)

  const neighborMap = new Map<string, NeighborLine>()
  for (const seed of seeds) {
    let neigh: NeighborLine[] = []
    if (seed.type === 'person') neigh = neighborsForPerson(seed.id)
    else if (seed.type === 'project') neigh = neighborsForProject(seed.id)
    else if (seed.type === 'quantomo') neigh = neighborsForQuantomo(seed.id)

    for (const n of neigh) {
      const key = `${n.type}:${n.id}`
      if (seeds.some((s) => s.type === n.type && s.id === n.id)) continue
      if (!neighborMap.has(key)) neighborMap.set(key, n)
    }
  }

  const seedLines =
    seeds.length === 0
      ? ['(ningún nodo semántico cercano)']
      : seeds.map(
          (s) =>
            `- [${s.type}] ${s.label} (score ${s.score.toFixed(3)})${s.snippet ? `: ${s.snippet}` : ''}`,
        )

  const neighbors = [...neighborMap.values()]
  const neighborLines =
    neighbors.length === 0
      ? ['(ninguno)']
      : neighbors.map(
          (n) => `- [${n.type}] ${n.label} (via ${n.via})`,
        )

  return [
    '## Seeds',
    ...seedLines,
    '',
    '## Neighbors',
    ...neighborLines,
  ].join('\n')
}

export interface GraphVizNode {
  id: string
  type: 'person' | 'project' | 'quantomo' | 'orphan'
  label: string
  kind?: string | null
  /** Grado de vínculos confirmados. */
  valence: number
  /** Masa visual: conexiones + menciones en entries. */
  mass: number
  /** Sin vínculo confirmado fuerte → niebla. */
  fog: boolean
  source?: string
  first_seen: string | null
  last_seen: string | null
  /** Quántomo: peso hermético 1–12. */
  hermetic_weight?: number | null
  content?: string | null
  universe?: string | null
  entry_id?: string | null
  is_operator?: boolean
  orphan?: boolean
  status?: string | null
  aliases?: string[]
  proposal_id?: string | null
}

export interface GraphLinkEvidence {
  entry_id: string
  title: string
  snippet: string
  at: string | null
}

export interface GraphVizLink {
  id: string
  source: string
  target: string
  kind: 'confirmed' | 'suggested' | 'semantic' | 'orbit'
  role?: string
  weight: number
  /** Similitud coseno [0..1] si aplica. */
  similarity?: number
  created_at?: string | null
  evidence?: GraphLinkEvidence[]
}

export interface GraphHeatBucket {
  day: string
  count: number
}

export interface GraphSnapshot {
  nodes: GraphVizNode[]
  links: GraphVizLink[]
  time_range: { min: string | null; max: string | null }
  heatmap: GraphHeatBucket[]
  operator_id: string | null
  stats: {
    persons: number
    projects: number
    quantomos: number
    orphans: number
    confirmed_links: number
    suggested_links: number
    semantic_links: number
  }
}

/**
 * Snapshot del grafo para visualización (masa, fog, evidencia, gravedad semántica).
 */
export function getGraphSnapshot(opts?: {
  includeSuggestions?: boolean
}): GraphSnapshot {
  const db = getDb()
  const includeSuggestions = opts?.includeSuggestions !== false
  const model = process.env.COHERE_EMBED_MODEL?.replace(/^["']|["']$/g, '') || 'embed-v4.0'

  const persons = rows<{
    id: string
    name: string
    kind: string
    source: string
    created_at: string
    is_operator: number
    aliases: string
    notes: string | null
    status: string
  }>(
    db
      .prepare(
        `
      SELECT id, name, kind, source, created_at, is_operator, aliases, notes, status
      FROM persons
      WHERE (merged_into IS NULL OR merged_into = '')
        AND status != 'merged'
      ORDER BY name COLLATE NOCASE
      `,
      )
      .all(),
  )

  const projects = rows<{
    id: string
    title: string
    category: string | null
    source: string
    created_at: string
    aliases: string | null
    notes: string | null
    status: string
    tactical_focus: string | null
  }>(
    db
      .prepare(
        `
      SELECT id, title, category, source, created_at, aliases, notes, status, tactical_focus
      FROM projects
      WHERE (merged_into IS NULL OR merged_into = '')
      ORDER BY title COLLATE NOCASE
      `,
      )
      .all(),
  )

  const confirmed = rows<{
    id: string
    person_id: string
    project_id: string
    role: string
    created_at: string
  }>(
    db
      .prepare(
        `
      SELECT id, person_id, project_id, role, created_at
      FROM person_project_links
      `,
      )
      .all(),
  )

  const mentionCounts = rows<{
    entity_id: string
    c: number
  }>(
    db
      .prepare(
        `
      SELECT entity_id, COUNT(*) as c
      FROM entity_links
      WHERE entity_kind IN ('person', 'project')
      GROUP BY entity_id
      `,
      )
      .all(),
  )
  const mentions = new Map(mentionCounts.map((r) => [r.entity_id, Number(r.c) || 0]))

  const activity = rows<{
    entity_id: string
    first_seen: string | null
    last_seen: string | null
  }>(
    db
      .prepare(
        `
      SELECT
        l.entity_id,
        MIN(
          CASE
            WHEN e.timestamp_exact IS NOT NULL
             AND e.timestamp_exact >= '2024-01-01'
             AND e.timestamp_exact < '2030-01-01'
            THEN e.timestamp_exact
            ELSE COALESCE(e.created_at, l.created_at)
          END
        ) AS first_seen,
        MAX(
          CASE
            WHEN e.timestamp_exact IS NOT NULL
             AND e.timestamp_exact >= '2024-01-01'
             AND e.timestamp_exact < '2030-01-01'
            THEN e.timestamp_exact
            ELSE COALESCE(e.created_at, l.created_at)
          END
        ) AS last_seen
      FROM entity_links l
      LEFT JOIN entries e ON e.id = l.entry_id
      WHERE l.entity_kind IN ('person', 'project')
      GROUP BY l.entity_id
      `,
      )
      .all(),
  )
  const activityMap = new Map(
    activity.map((a) => [a.entity_id, a] as const),
  )

  const degree = new Map<string, number>()
  for (const l of confirmed) {
    degree.set(l.person_id, (degree.get(l.person_id) ?? 0) + 1)
    degree.set(l.project_id, (degree.get(l.project_id) ?? 0) + 1)
  }

  function parseAliases(raw: string | null | undefined): string[] {
    try {
      const a = JSON.parse(raw || '[]') as unknown
      return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []
    } catch {
      return []
    }
  }

  const nodes: GraphVizNode[] = [
    ...persons.map((p) => {
      const valence = degree.get(p.id) ?? 0
      const m = mentions.get(p.id) ?? 0
      const act = activityMap.get(p.id)
      const first = act?.first_seen || p.created_at
      const last = act?.last_seen || p.created_at
      return {
        id: p.id,
        type: 'person' as const,
        label: p.name,
        kind: p.kind,
        valence,
        mass: valence * 3 + m + (p.source === 'manual' ? 2 : 0),
        fog: valence === 0,
        source: p.source,
        first_seen: first,
        last_seen: last,
        is_operator: !!p.is_operator,
        status: p.status,
        aliases: parseAliases(p.aliases),
        content: p.notes,
      }
    }),
    ...projects.map((p) => {
      const valence = degree.get(p.id) ?? 0
      const m = mentions.get(p.id) ?? 0
      const act = activityMap.get(p.id)
      const first = act?.first_seen || p.created_at
      const last = act?.last_seen || p.created_at
      return {
        id: p.id,
        type: 'project' as const,
        label: p.title,
        kind: p.category,
        valence,
        mass: valence * 3 + m + (p.source === 'manual' ? 2 : 0),
        fog: valence === 0,
        source: p.source,
        first_seen: first,
        last_seen: last,
        status: p.status,
        aliases: parseAliases(p.aliases),
        content: [p.tactical_focus, p.notes].filter(Boolean).join('\n') || null,
      }
    }),
  ]

  const nodeIds = new Set(nodes.map((n) => n.id))

  const evidenceStmt = db.prepare(`
    SELECT
      e.id AS entry_id,
      e.title,
      e.content_raw,
      COALESCE(e.timestamp_exact, e.created_at) AS at
    FROM entity_links pe
    INNER JOIN entity_links pr
      ON pr.entry_id = pe.entry_id
     AND pr.entity_kind = 'project'
     AND pr.entity_id = ?
    INNER JOIN entries e ON e.id = pe.entry_id
    WHERE pe.entity_kind = 'person'
      AND pe.entity_id = ?
    ORDER BY COALESCE(e.timestamp_exact, e.created_at) DESC
    LIMIT 3
  `)

  function evidenceFor(personId: string, projectId: string): GraphLinkEvidence[] {
    const raw = rows<{
      entry_id: string
      title: string
      content_raw: string | null
      at: string | null
    }>(evidenceStmt.all(projectId, personId))
    return raw.map((r) => ({
      entry_id: r.entry_id,
      title: r.title,
      snippet: (r.content_raw ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220),
      at: r.at,
    }))
  }

  const links: GraphVizLink[] = confirmed
    .filter((l) => nodeIds.has(l.person_id) && nodeIds.has(l.project_id))
    .map((l) => {
      const evidence = evidenceFor(l.person_id, l.project_id)
      return {
        id: l.id,
        source: l.person_id,
        target: l.project_id,
        kind: 'confirmed' as const,
        role: l.role,
        weight: Math.max(1, evidence.length),
        created_at: l.created_at,
        evidence,
      }
    })

  let suggestedCount = 0
  if (includeSuggestions) {
    const suggestions = discoverLinks({ limit: 80 })
    for (const s of suggestions) {
      if (!nodeIds.has(s.person_id) || !nodeIds.has(s.project_id)) continue
      const evidence = evidenceFor(s.person_id, s.project_id)
      links.push({
        id: `sug:${s.person_id}:${s.project_id}`,
        source: s.person_id,
        target: s.project_id,
        kind: 'suggested',
        role: s.suggested_role,
        weight: s.shared_entry_count,
        created_at: evidence[0]?.at ?? null,
        evidence,
      })
      suggestedCount += 1
    }
  }

  // —— Quántomos (estrellas en órbita de maestros) ——
  const quantomos = rows<{
    id: string
    entry_id: string
    title: string
    content: string | null
    hermetic_weight: number | null
    universe: string | null
    recognized: number
    at: string | null
    entry_status: string
  }>(
    db
      .prepare(
        `
      SELECT
        q.id, q.entry_id, q.title, q.content, q.hermetic_weight, q.universe, q.recognized,
        CASE
          WHEN e.timestamp_exact IS NOT NULL
           AND e.timestamp_exact >= '2024-01-01'
           AND e.timestamp_exact < '2030-01-01'
          THEN e.timestamp_exact
          ELSE e.created_at
        END AS at,
        e.status AS entry_status
      FROM quantomos q
      INNER JOIN entries e ON e.id = q.entry_id
      WHERE q.recognized = 1 OR e.status = 'pending_review'
      ORDER BY q.hermetic_weight DESC
      LIMIT 1200
      `,
      )
      .all(),
  )

  const entryMasters = rows<{
    entry_id: string
    entity_kind: string
    entity_id: string
  }>(
    db
      .prepare(
        `
      SELECT entry_id, entity_kind, entity_id
      FROM entity_links
      WHERE entity_kind IN ('person', 'project')
      `,
      )
      .all(),
  )
  const mastersByEntry = new Map<string, Array<{ kind: string; id: string }>>()
  for (const em of entryMasters) {
    if (!nodeIds.has(em.entity_id)) continue
    const list = mastersByEntry.get(em.entry_id) ?? []
    list.push({ kind: em.entity_kind, id: em.entity_id })
    mastersByEntry.set(em.entry_id, list)
  }

  let quantomoCount = 0
  for (const q of quantomos) {
    const w = Math.max(1, Math.min(12, Number(q.hermetic_weight) || 5))
    const orphanQ = q.entry_status === 'pending_review' || q.recognized !== 1
    nodes.push({
      id: q.id,
      type: 'quantomo',
      label: q.title,
      kind: q.universe,
      valence: 0,
      mass: w,
      fog: orphanQ,
      orphan: orphanQ,
      hermetic_weight: w,
      content: q.content,
      universe: q.universe,
      entry_id: q.entry_id,
      first_seen: q.at,
      last_seen: q.at,
      status: q.entry_status,
    })
    nodeIds.add(q.id)
    quantomoCount += 1

    const masters = mastersByEntry.get(q.entry_id) ?? []
    const prefer =
      masters.find((m) => m.kind === 'project') ??
      masters.find((m) => m.kind === 'person')
    if (prefer) {
      links.push({
        id: `orbit:${q.id}:${prefer.id}`,
        source: q.id,
        target: prefer.id,
        kind: 'orbit',
        weight: w,
        created_at: q.at,
      })
    }
  }

  // —— Huérfanos Aduana (propuestas pending) ——
  const pending = rows<{
    id: string
    kind: string
    suggested_name: string
    created_at: string
    evidence: string | null
  }>(
    db
      .prepare(
        `
      SELECT id, kind, suggested_name, created_at, evidence
      FROM entity_proposals
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT 80
      `,
      )
      .all(),
  )

  let orphanCount = 0
  for (const p of pending) {
    let snippet = ''
    try {
      const ev = JSON.parse(p.evidence || '{}') as { snippet?: string }
      snippet = String(ev.snippet ?? '')
    } catch {
      /* ignore */
    }
    const oid = `orphan:${p.id}`
    nodes.push({
      id: oid,
      type: 'orphan',
      label: p.suggested_name,
      kind: p.kind,
      valence: 0,
      mass: 2,
      fog: true,
      orphan: true,
      proposal_id: p.id,
      content: snippet || null,
      first_seen: p.created_at,
      last_seen: p.created_at,
      status: 'pending',
    })
    nodeIds.add(oid)
    orphanCount += 1
  }

  // —— Gravedad semántica (aristas invisibles para d3-force) ——
  const embRows = rows<{
    object_type: string
    object_id: string
    vector: string
  }>(
    db
      .prepare(
        `
      SELECT object_type, object_id, vector
      FROM embeddings
      WHERE model = ?
        AND object_type IN ('person', 'project')
      `,
      )
      .all(model),
  )

  const vectors = new Map<string, number[]>()
  for (const r of embRows) {
    if (!nodeIds.has(r.object_id)) continue
    try {
      const v = JSON.parse(r.vector) as number[]
      if (Array.isArray(v) && v.length > 0) vectors.set(r.object_id, v)
    } catch {
      /* ignore */
    }
  }

  const idList = [...vectors.keys()]
  const SEM_MIN = 0.42
  const TOP_K = 4
  let semanticCount = 0
  const existingPair = new Set(
    links.map((l) => {
      const a = String(l.source)
      const b = String(l.target)
      return a < b ? `${a}|${b}` : `${b}|${a}`
    }),
  )

  for (let i = 0; i < idList.length; i++) {
    const a = idList[i]!
    const va = vectors.get(a)!
    const scored: Array<{ id: string; sim: number }> = []
    for (let j = 0; j < idList.length; j++) {
      if (i === j) continue
      const b = idList[j]!
      const vb = vectors.get(b)!
      const sim = cosineSimilarity(va, vb)
      if (sim >= SEM_MIN) scored.push({ id: b, sim })
    }
    scored.sort((x, y) => y.sim - x.sim)
    for (const hit of scored.slice(0, TOP_K)) {
      const pairKey = a < hit.id ? `${a}|${hit.id}` : `${hit.id}|${a}`
      if (existingPair.has(pairKey)) {
        // Anotar similitud en arista visible existente
        const vis = links.find((l) => {
          const s = String(l.source)
          const t = String(l.target)
          return (
            (s === a && t === hit.id) ||
            (s === hit.id && t === a)
          )
        })
        if (vis && vis.similarity == null) vis.similarity = hit.sim
        continue
      }
      existingPair.add(pairKey)
      links.push({
        id: `sem:${pairKey}`,
        source: a,
        target: hit.id,
        kind: 'semantic',
        weight: hit.sim,
        similarity: hit.sim,
      })
      semanticCount += 1
    }
  }

  // Rellenar similitud en confirmados/sugeridos cuando ambos tienen vector
  for (const l of links) {
    if (l.kind === 'semantic' || l.similarity != null) continue
    const va = vectors.get(String(l.source))
    const vb = vectors.get(String(l.target))
    if (va && vb) l.similarity = cosineSimilarity(va, vb)
  }

  let tMin: string | null = null
  let tMax: string | null = null
  for (const n of nodes) {
    for (const ts of [n.first_seen, n.last_seen]) {
      if (!ts) continue
      if (!tMin || ts < tMin) tMin = ts
      if (!tMax || ts > tMax) tMax = ts
    }
  }
  for (const l of links) {
    if (!l.created_at) continue
    if (!tMin || l.created_at < tMin) tMin = l.created_at
    if (!tMax || l.created_at > tMax) tMax = l.created_at
  }

  const heatRows = rows<{ day: string; count: number }>(
    db
      .prepare(
        `
      SELECT substr(
        CASE
          WHEN e.timestamp_exact IS NOT NULL
           AND e.timestamp_exact >= '2024-01-01'
           AND e.timestamp_exact < '2030-01-01'
          THEN e.timestamp_exact
          ELSE e.created_at
        END
      , 1, 10) AS day,
             COUNT(*) AS count
      FROM quantomos q
      INNER JOIN entries e ON e.id = q.entry_id
      WHERE e.created_at IS NOT NULL
      GROUP BY day
      HAVING day >= '2024-01-01' AND day < '2030-01-01'
      ORDER BY day ASC
      `,
      )
      .all(),
  )
  const heatmap: GraphHeatBucket[] = heatRows.map((h) => ({
    day: h.day,
    count: Number(h.count) || 0,
  }))

  // Acotar time_range a fechas sensatas (ignora outliers tipo 1995)
  const clampTs = (ts: string | null): string | null => {
    if (!ts) return null
    if (ts < '2024-01-01' || ts >= '2030-01-01') return null
    return ts
  }
  tMin = clampTs(tMin)
  tMax = clampTs(tMax)
  if (!tMin && heatmap.length) tMin = heatmap[0]!.day
  if (!tMax && heatmap.length) tMax = heatmap[heatmap.length - 1]!.day
  for (const n of nodes) {
    n.first_seen = clampTs(n.first_seen) ?? n.first_seen
    n.last_seen = clampTs(n.last_seen) ?? n.last_seen
    // Si first_seen quedó absurdo, usar created fallback ya aplicado en SQL
    if (n.first_seen && (n.first_seen < '2024-01-01' || n.first_seen >= '2030-01-01')) {
      n.first_seen = tMin
    }
    if (n.last_seen && (n.last_seen < '2024-01-01' || n.last_seen >= '2030-01-01')) {
      n.last_seen = n.first_seen
    }
  }
  return {
    nodes,
    links,
    time_range: { min: tMin, max: tMax },
    heatmap,
    operator_id: getOperatorId(db),
    stats: {
      persons: persons.length,
      projects: projects.length,
      quantomos: quantomoCount,
      orphans: orphanCount,
      confirmed_links: confirmed.length,
      suggested_links: suggestedCount,
      semantic_links: semanticCount,
    },
  }
}

/** Búsqueda vectorial / léxica para zoom cinemático en el grafo. */
export async function searchGraphNodes(
  query: string,
  limit = 12,
): Promise<Array<{ id: string; type: string; label: string; score: number }>> {
  const q = query.trim()
  if (!q) return []
  const db = getDb()
  const hits = await searchSimilar(q, {
    types: ['person', 'project', 'quantomo'],
    limit,
  })

  const out: Array<{ id: string; type: string; label: string; score: number }> =
    []
  for (const h of hits) {
    if (h.object_type === 'person') {
      const p = row<{ name: string }>(
        db.prepare(`SELECT name FROM persons WHERE id = ?`).get(h.object_id),
      )
      if (p) out.push({ id: h.object_id, type: 'person', label: p.name, score: h.score })
    } else if (h.object_type === 'project') {
      const p = row<{ title: string }>(
        db.prepare(`SELECT title FROM projects WHERE id = ?`).get(h.object_id),
      )
      if (p)
        out.push({
          id: h.object_id,
          type: 'project',
          label: p.title,
          score: h.score,
        })
    } else if (h.object_type === 'quantomo') {
      const qq = row<{ title: string }>(
        db.prepare(`SELECT title FROM quantomos WHERE id = ?`).get(h.object_id),
      )
      if (qq)
        out.push({
          id: h.object_id,
          type: 'quantomo',
          label: qq.title,
          score: h.score,
        })
    }
  }

  // Fallback léxico si Mnemosyne vacío
  if (out.length === 0) {
    const like = `%${q}%`
    const people = rows<{ id: string; name: string }>(
      db
        .prepare(
          `SELECT id, name FROM persons
           WHERE (merged_into IS NULL OR merged_into = '')
             AND name LIKE ? COLLATE NOCASE
           LIMIT 6`,
        )
        .all(like),
    )
    for (const p of people) {
      out.push({ id: p.id, type: 'person', label: p.name, score: 0.5 })
    }
    const projs = rows<{ id: string; title: string }>(
      db
        .prepare(
          `SELECT id, title FROM projects
           WHERE (merged_into IS NULL OR merged_into = '')
             AND title LIKE ? COLLATE NOCASE
           LIMIT 6`,
        )
        .all(like),
    )
    for (const p of projs) {
      out.push({ id: p.id, type: 'project', label: p.title, score: 0.5 })
    }
  }

  return out.slice(0, limit)
}
