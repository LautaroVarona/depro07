import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDb, syncPersonAliases, removePersonFts } from '../db.js'
import { row, rowRequired, rows } from '../sql.js'
import type {
  EntityLink,
  EntityProposal,
  Entry,
  Person,
  PersonKind,
} from '../types.js'
import {
  embedLinkContext,
  embedPerson,
  enqueueEmbed,
} from '../services/embeddings.js'
import { liveSuggestedMatch, expandMentionContext } from '../services/entityMatch.js'
import {
  isProfileKind,
  normalizePersonKind,
  PROFILE_KINDS,
} from '../services/personKinds.js'
import {
  buildWaitingWithMatches,
  listMasterProfiles,
} from '../services/personMatchmaker.js'
import {
  getOperatorId,
  normalizePersonProjectRole,
  normalizeRelationType,
} from '../services/entityRelations.js'
import { searchSimilar } from '../services/embeddings.js'
import { typeaheadEntities } from '../services/typeahead.js'
import { dismissGraphLinkSuggestion } from '../services/graph.js'

export const personsRouter = Router()

function parseAliases(raw: unknown): string {
  if (Array.isArray(raw)) {
    return JSON.stringify(raw.map((a) => String(a).trim()).filter(Boolean))
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return JSON.stringify(
          parsed.map((a) => String(a).trim()).filter(Boolean),
        )
      }
    } catch {
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return JSON.stringify(parts)
    }
  }
  return '[]'
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    return {}
  }
}

function parseEvidence(raw: string | null): {
  snippet?: string
  mention?: string
} {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as { snippet?: string; mention?: string }
  } catch {
    return { snippet: raw }
  }
}

function mergeAliasJson(
  existingJson: string,
  extra: string[],
): string {
  let list: string[] = []
  try {
    list = JSON.parse(existingJson || '[]') as string[]
  } catch {
    list = []
  }
  for (const a of extra) {
    const t = a.trim()
    if (
      t &&
      !list.some((x) => x.toLowerCase() === t.toLowerCase())
    ) {
      list.push(t)
    }
  }
  return JSON.stringify(list)
}

personsRouter.get('/', (_req, res) => {
  const db = getDb()
  const linkCount = db.prepare(
    `SELECT COUNT(*) as c FROM entity_links WHERE entity_kind = 'person' AND entity_id = ?`,
  )

  const profiles = listMasterProfiles(db).map((p) => ({
    ...p,
    aliases_list: JSON.parse(p.aliases || '[]') as string[],
    link_count: rowRequired<{ c: number }>(linkCount.get(p.id)).c,
  }))

  const waiting = buildWaitingWithMatches(db)
  const operator_id = getOperatorId(db)
  const pending_proposals_count = rowRequired<{ c: number }>(
    db
      .prepare(
        `SELECT COUNT(*) as c FROM entity_proposals
         WHERE kind = 'person' AND status = 'pending'`,
      )
      .get(),
  ).c

  // Compat: persons = perfiles maestros (prioridad)
  res.json({
    profiles,
    waiting,
    persons: profiles,
    waiting_count: waiting.length,
    profile_count: profiles.length,
    pending_proposals_count,
    operator_id,
  })
})

personsRouter.get('/pending', (_req, res) => {
  const db = getDb()
  const proposals = rows<EntityProposal>(
    db
      .prepare(
        `SELECT * FROM entity_proposals
         WHERE kind = 'person' AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(),
  )

  const roster = listMasterProfiles(db)

  const getEntry = db.prepare(
    `SELECT id, title, status, content_raw, source_type, original_filename
     FROM entries WHERE id = ?`,
  )

  res.json({
    proposals: proposals.map((p) => {
      const entry = row<
        Pick<
          Entry,
          | 'id'
          | 'title'
          | 'status'
          | 'content_raw'
          | 'source_type'
          | 'original_filename'
        >
      >(getEntry.get(p.entry_id))
      const meta = parseMeta(p.suggested_meta)
      if (meta.kind === 'agrupacion' || meta.kind === 'ficticio') {
        meta.kind = 'ficticia'
      }

      let suggested_match: {
        id: string
        name: string
        score: number
      } | null = null

      if (p.proposal_type === 'link' && p.matched_entity_id) {
        const dest = roster.find((r) => r.id === p.matched_entity_id)
        suggested_match = {
          id: p.matched_entity_id,
          name: String(meta.matched_name ?? dest?.name ?? p.matched_entity_id),
          score: Number(meta.match_score ?? 1),
        }
      } else if (
        typeof meta.suggested_match_id === 'string' &&
        typeof meta.suggested_match_name === 'string'
      ) {
        suggested_match = {
          id: meta.suggested_match_id,
          name: meta.suggested_match_name,
          score: Number(meta.match_score ?? 0),
        }
      } else {
        suggested_match = liveSuggestedMatch(p.suggested_name, roster)
      }

      const evidence_parsed = parseEvidence(p.evidence)
      const context = expandMentionContext(
        entry?.content_raw,
        p.suggested_name,
      )

      return {
        ...p,
        meta,
        evidence_parsed: {
          ...evidence_parsed,
          context: context || evidence_parsed.snippet || '',
        },
        entry: entry
          ? {
              id: entry.id,
              title: entry.title,
              status: entry.status,
              source_type: entry.source_type,
              original_filename: entry.original_filename,
            }
          : null,
        suggested_match,
      }
    }),
  })
})

personsRouter.get('/export', (_req, res) => {
  const db = getDb()
  const profiles = listMasterProfiles(db)
  const linksStmt = db.prepare(
    `SELECT l.id, l.entry_id, l.quantomo_id, l.role, l.created_at,
            e.title as entry_title, e.timestamp_exact, e.original_filename
     FROM entity_links l
     JOIN entries e ON e.id = l.entry_id
     WHERE l.entity_kind = 'person' AND l.entity_id = ?
     ORDER BY l.created_at DESC`,
  )
  const relationsStmt = db.prepare(
    `SELECT r.*, pf.name as from_name, pt.name as to_name
     FROM person_relations r
     JOIN persons pf ON pf.id = r.from_person_id
     JOIN persons pt ON pt.id = r.to_person_id
     WHERE r.from_person_id = ? OR r.to_person_id = ?
     ORDER BY r.created_at DESC`,
  )
  const projectLinksStmt = db.prepare(
    `SELECT pp.*, p.title as project_title, p.category as project_category
     FROM person_project_links pp
     JOIN projects p ON p.id = pp.project_id
     WHERE pp.person_id = ?
     ORDER BY pp.created_at DESC`,
  )

  const payload = {
    exported_at: new Date().toISOString(),
    source: 'deprocast-personas',
    count: profiles.length,
    operator_id: getOperatorId(db),
    profiles: profiles.map((p) => {
      let aliases_list: string[] = []
      try {
        aliases_list = JSON.parse(p.aliases || '[]') as string[]
      } catch {
        aliases_list = []
      }
      const links = rows<{
        id: string
        entry_id: string
        quantomo_id: string | null
        role: string
        created_at: string
        entry_title: string
        timestamp_exact: string | null
        original_filename: string | null
      }>(linksStmt.all(p.id))
      const relations = rows<{
        id: string
        from_person_id: string
        to_person_id: string
        relation_type: string
        notes: string | null
        created_at: string
        from_name: string
        to_name: string
      }>(relationsStmt.all(p.id, p.id))
      const project_links = rows<{
        id: string
        person_id: string
        project_id: string
        role: string
        created_at: string
        project_title: string
        project_category: string | null
      }>(projectLinksStmt.all(p.id))

      return {
        id: p.id,
        name: p.name,
        kind: normalizePersonKind(p.kind),
        aliases: aliases_list,
        notes: p.notes,
        status: p.status,
        source: p.source,
        is_operator: !!p.is_operator,
        created_at: p.created_at,
        updated_at: p.updated_at,
        links: links.map((l) => ({
          entry_id: l.entry_id,
          entry_title: l.entry_title,
          original_filename: l.original_filename,
          timestamp_exact: l.timestamp_exact,
          role: l.role,
          quantomo_id: l.quantomo_id,
          linked_at: l.created_at,
        })),
        relations: relations.map((r) => ({
          id: r.id,
          from_person_id: r.from_person_id,
          to_person_id: r.to_person_id,
          from_name: r.from_name,
          to_name: r.to_name,
          relation_type: r.relation_type,
          notes: r.notes,
          created_at: r.created_at,
        })),
        project_links: project_links.map((pl) => ({
          id: pl.id,
          project_id: pl.project_id,
          project_title: pl.project_title,
          project_category: pl.project_category,
          role: pl.role,
          created_at: pl.created_at,
        })),
      }
    }),
  }

  res.json(payload)
})

personsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (!q) {
    res.json({ query: '', results: [] })
    return
  }

  const mode = String(req.query.mode ?? 'lexical').toLowerCase()
  const lexical = typeaheadEntities(q, {
    kinds: ['person'],
    limit: 30,
    scope: 'masters',
  })
  const scores = new Map<string, number>()
  for (const hit of lexical) scores.set(hit.id, hit.score)

  if (mode === 'semantic' || mode === 'hybrid') {
    try {
      const similar = await searchSimilar(q, { types: ['person'], limit: 40 })
      const masters = new Set(listMasterProfiles(getDb()).map((p) => p.id))
      for (const hit of similar) {
        if (!masters.has(hit.object_id)) continue
        const prev = scores.get(hit.object_id) ?? 0
        scores.set(hit.object_id, Math.max(prev, hit.score))
      }
    } catch (err) {
      console.warn('[persons/search] embedding fallback:', err)
    }
  }

  const db = getDb()
  const ids = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([id]) => id)

  const results = ids
    .map((id) => {
      const lex = lexical.find((h) => h.id === id)
      if (lex) {
        return {
          id: lex.id,
          name: lex.label,
          kind: lex.subtitle,
          aliases_list: lex.aliases,
          score: Math.round((scores.get(id) ?? lex.score) * 1000) / 1000,
        }
      }
      const p = row<Person>(
        db.prepare(`SELECT * FROM persons WHERE id = ?`).get(id),
      )
      if (!p) return null
      let aliases_list: string[] = []
      try {
        aliases_list = JSON.parse(p.aliases || '[]') as string[]
      } catch {
        aliases_list = []
      }
      return {
        id: p.id,
        name: p.name,
        kind: normalizePersonKind(p.kind),
        aliases_list,
        is_operator: !!p.is_operator,
        score: Math.round((scores.get(id) ?? 0) * 1000) / 1000,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  res.json({ query: q, results })
})

personsRouter.post('/:id/operator', (req, res) => {
  const db = getDb()
  const person = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(req.params.id),
  )
  if (!person) {
    res.status(404).json({ error: 'Persona no encontrada' })
    return
  }
  if (person.source !== 'manual' || person.merged_into) {
    res.status(400).json({ error: 'Solo un perfil maestro puede ser operador' })
    return
  }

  const enable = (req.body as { enable?: boolean })?.enable !== false
  const now = new Date().toISOString()
  db.exec('BEGIN')
  try {
    db.prepare(`UPDATE persons SET is_operator = 0, updated_at = ?`).run(now)
    if (enable) {
      db.prepare(
        `UPDATE persons SET is_operator = 1, updated_at = ? WHERE id = ?`,
      ).run(now, person.id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  res.json({
    ok: true,
    operator_id: enable ? person.id : null,
    person_id: person.id,
  })
})

personsRouter.post('/:id/relations', (req, res) => {
  const db = getDb()
  const fromId = String(req.params.id)
  const body = req.body as {
    to_person_id?: string
    relation_type?: string
    notes?: string
    to_operator?: boolean
  }

  let toId = String(body.to_person_id ?? '').trim()
  if (body.to_operator) {
    const op = getOperatorId(db)
    if (!op) {
      res.status(400).json({
        error: 'No hay perfil marcado como Yo | Operador',
      })
      return
    }
    toId = op
  }
  if (!toId) {
    res.status(400).json({ error: 'to_person_id requerido' })
    return
  }
  if (toId === fromId) {
    res.status(400).json({ error: 'No se puede vincular un perfil consigo mismo' })
    return
  }

  const from = row<Person>(db.prepare(`SELECT * FROM persons WHERE id = ?`).get(fromId))
  const to = row<Person>(db.prepare(`SELECT * FROM persons WHERE id = ?`).get(toId))
  if (!from || !to) {
    res.status(404).json({ error: 'Perfil no encontrado' })
    return
  }

  const relationType = normalizeRelationType(body.relation_type)
  const id = randomUUID()
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO person_relations (id, from_person_id, to_person_id, relation_type, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, fromId, toId, relationType, body.notes?.trim() || null, now)
  } catch {
    res.status(400).json({ error: 'Esa relación ya existe' })
    return
  }

  res.json({
    ok: true,
    relation: {
      id,
      from_person_id: fromId,
      to_person_id: toId,
      from_name: from.name,
      to_name: to.name,
      relation_type: relationType,
      notes: body.notes?.trim() || null,
      created_at: now,
    },
  })
})

personsRouter.delete('/relations/:relationId', (req, res) => {
  const db = getDb()
  const existing = row<{ id: string }>(
    db
      .prepare(`SELECT id FROM person_relations WHERE id = ?`)
      .get(req.params.relationId),
  )
  if (!existing) {
    res.status(404).json({ error: 'Relación no encontrada' })
    return
  }
  db.prepare(`DELETE FROM person_relations WHERE id = ?`).run(existing.id)
  res.json({ ok: true, id: existing.id })
})

personsRouter.post('/:id/projects', (req, res) => {
  const db = getDb()
  const personId = String(req.params.id)
  const body = req.body as { project_id?: string; role?: string }
  const projectId = String(body.project_id ?? '').trim()
  if (!projectId) {
    res.status(400).json({ error: 'project_id requerido' })
    return
  }

  const person = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId),
  )
  const project = row<{ id: string; title: string; category: string | null }>(
    db.prepare(`SELECT id, title, category FROM projects WHERE id = ?`).get(projectId),
  )
  if (!person || !project) {
    res.status(404).json({ error: 'Perfil o proyecto no encontrado' })
    return
  }

  const role = normalizePersonProjectRole(body.role)
  const id = randomUUID()
  const now = new Date().toISOString()
  try {
    db.prepare(
      `INSERT INTO person_project_links (id, person_id, project_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, personId, projectId, role, now)
  } catch {
    res.status(400).json({ error: 'Ese vínculo persona↔proyecto ya existe' })
    return
  }

  res.json({
    ok: true,
    link: {
      id,
      person_id: personId,
      project_id: projectId,
      person_name: person.name,
      project_title: project.title,
      project_category: project.category,
      role,
      created_at: now,
    },
  })
})

personsRouter.delete('/project-links/:linkId', (req, res) => {
  const db = getDb()
  const existing = row<{ id: string; person_id: string; project_id: string }>(
    db
      .prepare(
        `SELECT id, person_id, project_id FROM person_project_links WHERE id = ?`,
      )
      .get(req.params.linkId),
  )
  if (!existing) {
    res.status(404).json({ error: 'Vínculo no encontrado' })
    return
  }
  db.prepare(`DELETE FROM person_project_links WHERE id = ?`).run(existing.id)
  // Tras desvincular, no volver a sugerir el mismo par por co-ocurrencia
  dismissGraphLinkSuggestion(existing.person_id, existing.project_id)
  res.json({ ok: true, id: existing.id })
})

personsRouter.post('/:id/attach', (req, res) => {
  const db = getDb()
  const waiting = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(req.params.id),
  )
  if (!waiting) {
    res.status(404).json({ error: 'Entidad no encontrada' })
    return
  }
  if (waiting.source === 'manual' && !waiting.merged_into) {
    res.status(400).json({ error: 'Eso ya es un perfil maestro' })
    return
  }
  if (waiting.merged_into) {
    res.status(400).json({ error: 'Ya está vinculada a un perfil' })
    return
  }

  const masterId = String(
    (req.body as { master_id?: string })?.master_id ?? '',
  ).trim()
  if (!masterId) {
    res.status(400).json({ error: 'master_id requerido' })
    return
  }

  const master = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(masterId),
  )
  if (!master || master.source !== 'manual') {
    res.status(400).json({ error: 'Perfil maestro no encontrado' })
    return
  }

  const now = new Date().toISOString()
  let aliases: string[] = []
  try {
    aliases = JSON.parse(master.aliases || '[]') as string[]
  } catch {
    aliases = []
  }

  // El nombre visible en sala de espera SIEMPRE pasa a alias del maestro
  // (salvo que coincida con el nombre canónico del perfil).
  const extras = [waiting.name]
  try {
    extras.push(...(JSON.parse(waiting.aliases || '[]') as string[]))
  } catch {
    /* ignore */
  }
  for (const a of extras) {
    const t = String(a).trim()
    if (
      t &&
      t.toLowerCase() !== master.name.toLowerCase() &&
      !aliases.some((x) => x.toLowerCase() === t.toLowerCase())
    ) {
      aliases.push(t)
    }
  }
  const aliasesJson = JSON.stringify(aliases)

  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE persons SET aliases = ?, updated_at = ? WHERE id = ?`,
    ).run(aliasesJson, now, master.id)

    // Reasignar vínculos semánticos al maestro
    db.prepare(
      `UPDATE entity_links SET entity_id = ?
       WHERE entity_kind = 'person' AND entity_id = ?`,
    ).run(master.id, waiting.id)

    // Reasignar membresías de agrupaciones (evitar duplicados si el maestro ya está)
    const waitingMemberships = rows<{ id: string; agrupacion_id: string }>(
      db
        .prepare(
          `SELECT id, agrupacion_id FROM agrupacion_members WHERE person_id = ?`,
        )
        .all(waiting.id),
    )
    for (const m of waitingMemberships) {
      const already = row<{ id: string }>(
        db
          .prepare(
            `SELECT id FROM agrupacion_members
             WHERE agrupacion_id = ? AND person_id = ?`,
          )
          .get(m.agrupacion_id, master.id),
      )
      if (already) {
        db.prepare(`DELETE FROM agrupacion_members WHERE id = ?`).run(m.id)
      } else {
        db.prepare(
          `UPDATE agrupacion_members SET person_id = ? WHERE id = ?`,
        ).run(master.id, m.id)
      }
    }

    db.prepare(
      `UPDATE persons SET status = 'merged', merged_into = ?, updated_at = ?
       WHERE id = ?`,
    ).run(master.id, now, waiting.id)

    syncPersonAliases(master.id, master.name, aliasesJson)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  enqueueEmbed(() => embedPerson(master.id))

  res.json({
    ok: true,
    master_id: master.id,
    waiting_id: waiting.id,
    alias_added: waiting.name.trim(),
    aliases,
  })
})

personsRouter.post('/:id/promote', (req, res) => {
  const db = getDb()
  const person = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(req.params.id),
  )
  if (!person) {
    res.status(404).json({ error: 'Entidad no encontrada' })
    return
  }
  if (person.merged_into) {
    res.status(400).json({ error: 'Entidad ya fusionada en un perfil' })
    return
  }

  const body = req.body as {
    name?: string
    kind?: PersonKind
    aliases?: unknown
    notes?: string
  }

  const nextName = (body.name ?? person.name).trim()
  if (!nextName) {
    res.status(400).json({ error: 'name requerido' })
    return
  }
  const nextKind = normalizePersonKind(body.kind ?? person.kind)
  if (!isProfileKind(nextKind)) {
    res.status(400).json({
      error: `Perfiles solo: ${PROFILE_KINDS.join(', ')}`,
    })
    return
  }

  let aliasesJson = person.aliases
  if (body.aliases !== undefined) {
    aliasesJson = parseAliases(body.aliases)
  } else if (nextName !== person.name) {
    // conservar nombre original como alias
    let list: string[] = []
    try {
      list = JSON.parse(person.aliases || '[]') as string[]
    } catch {
      list = []
    }
    if (!list.some((a) => a.toLowerCase() === person.name.toLowerCase())) {
      list.push(person.name)
    }
    aliasesJson = JSON.stringify(list)
  }

  const nextNotes =
    body.notes !== undefined ? body.notes.trim() || null : person.notes
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE persons
     SET name = ?, kind = ?, aliases = ?, notes = ?, source = 'manual',
         status = 'active', merged_into = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(nextName, nextKind, aliasesJson, nextNotes, now, person.id)

  syncPersonAliases(person.id, nextName, aliasesJson)
  enqueueEmbed(() => embedPerson(person.id))

  const updated = rowRequired<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(person.id),
  )
  res.json({
    ok: true,
    person: {
      ...updated,
      kind: normalizePersonKind(updated.kind),
      aliases_list: JSON.parse(updated.aliases || '[]') as string[],
    },
  })
})

personsRouter.get('/:id', (req, res) => {
  const db = getDb()
  const person = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(req.params.id),
  )
  if (!person) {
    res.status(404).json({ error: 'Persona no encontrada' })
    return
  }

  const links = rows<
    EntityLink & { entry_title: string; timestamp_exact: string | null }
  >(
    db
      .prepare(
        `SELECT l.*, e.title as entry_title, e.timestamp_exact
         FROM entity_links l
         JOIN entries e ON e.id = l.entry_id
         WHERE l.entity_kind = 'person' AND l.entity_id = ?
         ORDER BY l.created_at DESC`,
      )
      .all(person.id),
  )

  const relationsRaw = rows<{
    id: string
    from_person_id: string
    to_person_id: string
    relation_type: string
    notes: string | null
    created_at: string
    from_name: string
    to_name: string
  }>(
    db
      .prepare(
        `SELECT r.*, pf.name as from_name, pt.name as to_name
         FROM person_relations r
         JOIN persons pf ON pf.id = r.from_person_id
         JOIN persons pt ON pt.id = r.to_person_id
         WHERE r.from_person_id = ? OR r.to_person_id = ?
         ORDER BY r.created_at DESC`,
      )
      .all(person.id, person.id),
  )

  const relations = relationsRaw.map((r) => {
    const outgoing = r.from_person_id === person.id
    return {
      ...r,
      direction: outgoing ? ('out' as const) : ('in' as const),
      other_id: outgoing ? r.to_person_id : r.from_person_id,
      other_name: outgoing ? r.to_name : r.from_name,
    }
  })

  const project_links = rows<{
    id: string
    person_id: string
    project_id: string
    role: string
    created_at: string
    project_title: string
    project_category: string | null
  }>(
    db
      .prepare(
        `SELECT pp.*, p.title as project_title, p.category as project_category
         FROM person_project_links pp
         JOIN projects p ON p.id = pp.project_id
         WHERE pp.person_id = ?
         ORDER BY pp.created_at DESC`,
      )
      .all(person.id),
  )

  res.json({
    person: {
      ...person,
      kind: normalizePersonKind(person.kind),
      aliases_list: JSON.parse(person.aliases || '[]') as string[],
      is_operator: !!person.is_operator,
    },
    links,
    relations,
    project_links,
    operator_id: getOperatorId(db),
  })
})

personsRouter.post('/', (req, res) => {
  const {
    name,
    kind = 'fisica',
    aliases,
    notes,
  } = req.body as {
    name?: string
    kind?: PersonKind
    aliases?: unknown
    notes?: string
  }

  if (!name?.trim()) {
    res.status(400).json({ error: 'name requerido' })
    return
  }

  const personKind = normalizePersonKind(kind)
  if (!isProfileKind(personKind)) {
    res.status(400).json({
      error: `Perfiles maestros solo: ${PROFILE_KINDS.join(', ')}`,
    })
    return
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const aliasesJson = parseAliases(aliases)
  const db = getDb()
  db.prepare(
    `INSERT INTO persons (id, name, kind, aliases, notes, status, created_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'manual')`,
  ).run(
    id,
    name.trim(),
    personKind,
    aliasesJson,
    notes?.trim() || null,
    now,
    now,
  )

  syncPersonAliases(id, name.trim(), aliasesJson)
  enqueueEmbed(() => embedPerson(id))

  const person = rowRequired<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(id),
  )
  res.status(201).json({
    ok: true,
    person: {
      ...person,
      aliases_list: JSON.parse(person.aliases || '[]') as string[],
    },
  })
})

personsRouter.patch('/:id', (req, res) => {
  const db = getDb()
  const existing = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(req.params.id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Persona no encontrada' })
    return
  }

  const { name, kind, aliases, notes, status } = req.body as {
    name?: string
    kind?: PersonKind
    aliases?: unknown
    notes?: string
    status?: string
  }

  const nextName = name?.trim() || existing.name
  let nextKind = existing.kind
  if (kind !== undefined) {
    const k = normalizePersonKind(kind)
    if (!isProfileKind(k)) {
      res.status(400).json({
        error: `Perfiles maestros solo: ${PROFILE_KINDS.join(', ')}`,
      })
      return
    }
    nextKind = k
  }
  const nextAliases =
    aliases !== undefined ? parseAliases(aliases) : existing.aliases
  const nextNotes = notes !== undefined ? notes.trim() || null : existing.notes
  const nextStatus = status?.trim() || existing.status
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE persons SET name = ?, kind = ?, aliases = ?, notes = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextName, nextKind, nextAliases, nextNotes, nextStatus, now, existing.id)

  syncPersonAliases(existing.id, nextName, nextAliases)
  enqueueEmbed(() => embedPerson(existing.id))

  const person = rowRequired<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(existing.id),
  )
  res.json({
    ok: true,
    person: {
      ...person,
      aliases_list: JSON.parse(person.aliases || '[]') as string[],
    },
  })
})

personsRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const existing = row<{ id: string }>(
    db.prepare(`SELECT id FROM persons WHERE id = ?`).get(req.params.id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Persona no encontrada' })
    return
  }

  db.exec('BEGIN')
  try {
    db.prepare(
      `DELETE FROM entity_links WHERE entity_kind = 'person' AND entity_id = ?`,
    ).run(existing.id)
    db.prepare(`DELETE FROM entity_aliases WHERE person_id = ?`).run(
      existing.id,
    )
    removePersonFts(existing.id)
    db.prepare(
      `DELETE FROM embeddings WHERE object_type = 'person' AND object_id = ?`,
    ).run(existing.id)
    db.prepare(`DELETE FROM agrupacion_members WHERE person_id = ?`).run(
      existing.id,
    )
    db.prepare(`DELETE FROM persons WHERE id = ?`).run(existing.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  res.json({ ok: true, id: existing.id })
})

personsRouter.post('/proposals/:id/approve', (req, res) => {
  const db = getDb()
  const proposal = row<EntityProposal>(
    db
      .prepare(`SELECT * FROM entity_proposals WHERE id = ? AND kind = 'person'`)
      .get(req.params.id),
  )

  if (!proposal) {
    res.status(404).json({ error: 'Propuesta no encontrada' })
    return
  }
  if (proposal.status !== 'pending') {
    res.status(400).json({ error: 'Propuesta ya resuelta' })
    return
  }

  const body = req.body as {
    name?: string
    kind?: PersonKind
    aliases?: unknown
    notes?: string
    matched_entity_id?: string
    /** create | link — fuerza modo desde el validador */
    as?: 'create' | 'link'
  }

  const meta = parseMeta(proposal.suggested_meta)
  const now = new Date().toISOString()
  const originalName = proposal.suggested_name
  const name = (body.name ?? originalName).trim()
  if (!name) {
    res.status(400).json({ error: 'name requerido' })
    return
  }

  const requestedKind = normalizePersonKind(
    body.kind ?? meta.kind ?? 'fisica',
  )

  // Abstracta / ruido → descartar (no crear perfil)
  if (requestedKind === 'abstracta' || requestedKind === 'ruido') {
    db.prepare(
      `UPDATE entity_proposals SET status = 'rejected', resolved_at = ?,
         suggested_meta = ? WHERE id = ?`,
    ).run(
      now,
      JSON.stringify({
        ...meta,
        kind: requestedKind,
        discard_reason: requestedKind,
      }),
      proposal.id,
    )
    res.json({
      ok: true,
      discarded: true,
      proposal_id: proposal.id,
      status: 'rejected',
      reason: requestedKind,
    })
    return
  }

  const forceLink = body.as === 'link' || !!body.matched_entity_id
  const mode: 'create' | 'link' =
    forceLink || proposal.proposal_type === 'link' ? 'link' : 'create'

  let personId: string

  db.exec('BEGIN')
  try {
    if (mode === 'create') {
      personId = randomUUID()
      const personKind = isProfileKind(requestedKind)
        ? requestedKind
        : 'fisica'

      let aliasesRaw = body.aliases ?? meta.aliases ?? []
      if (name !== originalName) {
        const list =
          typeof aliasesRaw === 'string'
            ? aliasesRaw.split(',').map((s) => s.trim()).filter(Boolean)
            : Array.isArray(aliasesRaw)
              ? aliasesRaw.map((a) => String(a))
              : []
        if (!list.some((a) => a.toLowerCase() === originalName.toLowerCase())) {
          list.push(originalName)
        }
        aliasesRaw = list
      }

      const aliasesJson = parseAliases(aliasesRaw)
      db.prepare(
        `INSERT INTO persons (id, name, kind, aliases, notes, status, created_at, updated_at, source)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'extractor')`,
      ).run(
        personId,
        name,
        personKind,
        aliasesJson,
        body.notes?.trim() || null,
        now,
        now,
      )
      syncPersonAliases(personId, name, aliasesJson)
    } else {
      personId = body.matched_entity_id || proposal.matched_entity_id || ''
      if (!personId) {
        throw new Error('matched_entity_id requerido para vincular')
      }
      const person = row<Person>(
        db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId),
      )
      if (!person) {
        throw new Error('Persona destino no encontrada')
      }

      // Mención cruda → alias; si renombran la ficha, conservar viejos
      const extras = [originalName, name].filter(
        (a) => a && a.toLowerCase() !== person.name.toLowerCase(),
      )
      let nextName = person.name
      let nextAliases = mergeAliasJson(person.aliases, extras)

      if (body.name && body.name.trim() !== person.name) {
        // No renombrar el maestro al vincular salvo que as=link con name igual al match
        // Solo agregamos alias
        nextAliases = mergeAliasJson(nextAliases, [body.name.trim()])
      }

      db.prepare(
        `UPDATE persons SET name = ?, aliases = ?, updated_at = ? WHERE id = ?`,
      ).run(nextName, nextAliases, now, personId)
      syncPersonAliases(personId, nextName, nextAliases)
    }

    const nextMeta = JSON.stringify({
      ...meta,
      kind: body.kind ?? meta.kind ?? 'fisica',
      display_name: name,
      original_name: originalName,
      resolved_as: mode,
    })
    db.prepare(
      `UPDATE entity_proposals
       SET suggested_name = ?, suggested_meta = ?, status = 'approved',
           proposal_type = ?, matched_entity_id = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(name, nextMeta, mode, personId, now, proposal.id)

    db.prepare(
      `UPDATE entry_entities_raw SET name = ?
       WHERE entry_id = ? AND name = ? AND type IN ('person', 'persona')`,
    ).run(name, proposal.entry_id, originalName)

    const linkId = randomUUID()
    db.prepare(
      `INSERT INTO entity_links (id, entity_kind, entity_id, entry_id, quantomo_id, role, created_at)
       VALUES (?, 'person', ?, ?, NULL, 'mentioned', ?)`,
    ).run(linkId, personId, proposal.entry_id, now)

    db.exec('COMMIT')

    const person = rowRequired<Person>(
      db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId),
    )
    const entry = row<{ title: string }>(
      db.prepare(`SELECT title FROM entries WHERE id = ?`).get(proposal.entry_id),
    )
    const evidence = parseEvidence(proposal.evidence)

    enqueueEmbed(async () => {
      await embedPerson(personId)
      await embedLinkContext(
        linkId,
        'person',
        person.name,
        entry?.title ?? proposal.entry_id,
        evidence.snippet ?? '',
      )
    })

    res.json({
      ok: true,
      person_id: personId,
      link_id: linkId,
      proposal_id: proposal.id,
      mode,
    })
  } catch (err) {
    db.exec('ROLLBACK')
    const message = err instanceof Error ? err.message : 'Error al aprobar'
    res.status(400).json({ error: message })
  }
})

personsRouter.post('/proposals/:id/reject', (req, res) => {
  const db = getDb()
  const proposal = row<EntityProposal>(
    db
      .prepare(`SELECT * FROM entity_proposals WHERE id = ? AND kind = 'person'`)
      .get(req.params.id),
  )

  if (!proposal) {
    res.status(404).json({ error: 'Propuesta no encontrada' })
    return
  }
  if (proposal.status !== 'pending') {
    res.status(400).json({ error: 'Propuesta ya resuelta' })
    return
  }

  const reason = (req.body as { reason?: string })?.reason
  const meta = parseMeta(proposal.suggested_meta)

  db.prepare(
    `UPDATE entity_proposals SET status = 'rejected', resolved_at = ?,
       suggested_meta = ? WHERE id = ?`,
  ).run(
    new Date().toISOString(),
    JSON.stringify({ ...meta, discard_reason: reason ?? 'manual' }),
    proposal.id,
  )

  res.json({ ok: true, proposal_id: proposal.id, status: 'rejected' })
})
