import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDb, syncProjectAliases, removeProjectFts } from '../db.js'
import { row, rowRequired, rows } from '../sql.js'
import type {
  EntityLink,
  EntityProposal,
  Entry,
  Project,
  ProjectStatus,
} from '../types.js'
import {
  embedLinkContext,
  embedProject,
  enqueueEmbed,
  searchSimilar,
} from '../services/embeddings.js'
import { normalizeProjectKind } from '../services/entityRelations.js'
import {
  buildWaitingWithMatches,
  listMasterProjects,
} from '../services/projectMatchmaker.js'
import { liveSuggestedProjectMatch, expandMentionContext } from '../services/entityMatch.js'
import { typeaheadEntities } from '../services/typeahead.js'

export const projectsRouter = Router()

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

function normalizeStatus(raw: unknown, fallback: ProjectStatus): ProjectStatus {
  const s = String(raw ?? fallback).toLowerCase()
  if (['activo', 'pausado', 'cerrado', 'emergente'].includes(s)) {
    return s as ProjectStatus
  }
  return fallback
}

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
      /* comma-separated */
    }
    return JSON.stringify(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }
  return '[]'
}

function mergeAliasJson(existingJson: string, extra: string[]): string {
  let list: string[] = []
  try {
    list = JSON.parse(existingJson || '[]') as string[]
  } catch {
    list = []
  }
  for (const a of extra) {
    const t = a.trim()
    if (t && !list.some((x) => x.toLowerCase() === t.toLowerCase())) {
      list.push(t)
    }
  }
  return JSON.stringify(list)
}

function aliasesList(p: Project): string[] {
  try {
    return JSON.parse(p.aliases || '[]') as string[]
  } catch {
    return []
  }
}

projectsRouter.get('/', (_req, res) => {
  const db = getDb()
  const linkCount = db.prepare(
    `SELECT COUNT(*) as c FROM entity_links WHERE entity_kind = 'project' AND entity_id = ?`,
  )
  const personCount = db.prepare(
    `SELECT COUNT(*) as c FROM person_project_links WHERE project_id = ?`,
  )

  const profiles = listMasterProjects(db).map((p) => ({
    ...p,
    category: normalizeProjectKind(p.category),
    aliases_list: aliasesList(p),
    link_count: rowRequired<{ c: number }>(linkCount.get(p.id)).c,
    person_count: rowRequired<{ c: number }>(personCount.get(p.id)).c,
  }))

  const waiting = buildWaitingWithMatches(db)
  const pending_proposals_count = rowRequired<{ c: number }>(
    db
      .prepare(
        `SELECT COUNT(*) as c FROM entity_proposals
         WHERE kind = 'project' AND status = 'pending'`,
      )
      .get(),
  ).c

  res.json({
    profiles,
    waiting,
    projects: profiles,
    waiting_count: waiting.length,
    profile_count: profiles.length,
    pending_proposals_count,
  })
})

projectsRouter.get('/pending', (_req, res) => {
  const db = getDb()
  const proposals = rows<EntityProposal>(
    db
      .prepare(
        `SELECT * FROM entity_proposals
         WHERE kind = 'project' AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(),
  )

  const roster = listMasterProjects(db)
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

      let suggested_match: {
        id: string
        name: string
        score: number
      } | null = null

      if (p.proposal_type === 'link' && p.matched_entity_id) {
        const dest = roster.find((r) => r.id === p.matched_entity_id)
        suggested_match = {
          id: p.matched_entity_id,
          name: String(meta.matched_title ?? dest?.title ?? p.matched_entity_id),
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
        suggested_match = liveSuggestedProjectMatch(p.suggested_name, roster)
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

projectsRouter.get('/export', (_req, res) => {
  const db = getDb()
  const profiles = listMasterProjects(db)
  const linksStmt = db.prepare(
    `SELECT l.id, l.entry_id, l.quantomo_id, l.role, l.created_at,
            e.title as entry_title, e.timestamp_exact, e.original_filename
     FROM entity_links l
     JOIN entries e ON e.id = l.entry_id
     WHERE l.entity_kind = 'project' AND l.entity_id = ?
     ORDER BY l.created_at DESC`,
  )
  const peopleStmt = db.prepare(
    `SELECT pp.*, pe.name as person_name
     FROM person_project_links pp
     JOIN persons pe ON pe.id = pp.person_id
     WHERE pp.project_id = ?
     ORDER BY pp.created_at DESC`,
  )

  const payload = {
    exported_at: new Date().toISOString(),
    source: 'deprocast-proyectos',
    count: profiles.length,
    projects: profiles.map((p) => {
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
      const people = rows<{
        id: string
        person_id: string
        role: string
        created_at: string
        person_name: string
      }>(peopleStmt.all(p.id))

      return {
        id: p.id,
        title: p.title,
        category: normalizeProjectKind(p.category),
        status: p.status,
        tactical_focus: p.tactical_focus,
        notes: p.notes,
        aliases: aliasesList(p),
        source: p.source,
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
        people: people.map((pe) => ({
          person_id: pe.person_id,
          person_name: pe.person_name,
          role: pe.role,
          linked_at: pe.created_at,
        })),
      }
    }),
  }

  res.json(payload)
})

projectsRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (!q) {
    res.json({ query: '', results: [] })
    return
  }

  const mode = String(req.query.mode ?? 'lexical').toLowerCase()
  const lexical = typeaheadEntities(q, {
    kinds: ['project'],
    limit: 30,
    scope: 'masters',
  })
  const scores = new Map<string, number>()
  for (const hit of lexical) scores.set(hit.id, hit.score)

  if (mode === 'semantic' || mode === 'hybrid') {
    try {
      const similar = await searchSimilar(q, { types: ['project'], limit: 40 })
      const masters = new Set(listMasterProjects(getDb()).map((p) => p.id))
      for (const hit of similar) {
        if (!masters.has(hit.object_id)) continue
        const prev = scores.get(hit.object_id) ?? 0
        scores.set(hit.object_id, Math.max(prev, hit.score))
      }
    } catch (err) {
      console.warn('[projects/search] embedding fallback:', err)
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
          title: lex.label,
          category: lex.subtitle,
          aliases_list: lex.aliases,
          score: Math.round((scores.get(id) ?? lex.score) * 1000) / 1000,
        }
      }
      const p = row<Project>(
        db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id),
      )
      if (!p) return null
      return {
        id: p.id,
        title: p.title,
        category: normalizeProjectKind(p.category),
        aliases_list: aliasesList(p),
        score: Math.round((scores.get(id) ?? 0) * 1000) / 1000,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  res.json({ query: q, results })
})

projectsRouter.post('/:id/attach', (req, res) => {
  const db = getDb()
  const waiting = row<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id),
  )
  if (!waiting) {
    res.status(404).json({ error: 'Entidad no encontrada' })
    return
  }
  if (waiting.source === 'manual' && !waiting.merged_into) {
    res.status(400).json({ error: 'Eso ya es un proyecto maestro' })
    return
  }
  if (waiting.merged_into) {
    res.status(400).json({ error: 'Ya está vinculada a un proyecto' })
    return
  }

  const masterId = String(
    (req.body as { master_id?: string })?.master_id ?? '',
  ).trim()
  if (!masterId) {
    res.status(400).json({ error: 'master_id requerido' })
    return
  }

  const master = row<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(masterId),
  )
  if (!master || master.source !== 'manual') {
    res.status(400).json({ error: 'Proyecto maestro no encontrado' })
    return
  }

  const now = new Date().toISOString()
  let aliases: string[] = aliasesList(master)
  const extras = [waiting.title, ...aliasesList(waiting)]
  for (const a of extras) {
    const t = String(a).trim()
    if (
      t &&
      t.toLowerCase() !== master.title.toLowerCase() &&
      !aliases.some((x) => x.toLowerCase() === t.toLowerCase())
    ) {
      aliases.push(t)
    }
  }
  const aliasesJson = JSON.stringify(aliases)

  db.exec('BEGIN')
  try {
    db.prepare(
      `UPDATE projects SET aliases = ?, updated_at = ? WHERE id = ?`,
    ).run(aliasesJson, now, master.id)

    db.prepare(
      `UPDATE entity_links SET entity_id = ?
       WHERE entity_kind = 'project' AND entity_id = ?`,
    ).run(master.id, waiting.id)

    // Reasignar personas; si hay conflicto UNIQUE, descartar el del waiting
    const waitingPeople = rows<{ id: string; person_id: string }>(
      db
        .prepare(`SELECT id, person_id FROM person_project_links WHERE project_id = ?`)
        .all(waiting.id),
    )
    for (const pl of waitingPeople) {
      const clash = row<{ id: string }>(
        db
          .prepare(
            `SELECT id FROM person_project_links
             WHERE person_id = ? AND project_id = ?`,
          )
          .get(pl.person_id, master.id),
      )
      if (clash) {
        db.prepare(`DELETE FROM person_project_links WHERE id = ?`).run(pl.id)
      } else {
        db.prepare(
          `UPDATE person_project_links SET project_id = ? WHERE id = ?`,
        ).run(master.id, pl.id)
      }
    }

    db.prepare(
      `UPDATE projects SET status = 'merged', merged_into = ?, updated_at = ?
       WHERE id = ?`,
    ).run(master.id, now, waiting.id)

    syncProjectAliases(master.id, master.title, aliasesJson)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  enqueueEmbed(() => embedProject(master.id))

  res.json({
    ok: true,
    master_id: master.id,
    waiting_id: waiting.id,
    alias_added: waiting.title.trim(),
    aliases,
  })
})

projectsRouter.post('/:id/promote', (req, res) => {
  const db = getDb()
  const project = row<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id),
  )
  if (!project) {
    res.status(404).json({ error: 'Proyecto no encontrado' })
    return
  }
  if (project.merged_into) {
    res.status(400).json({ error: 'Ya está mergeado' })
    return
  }

  const body = req.body as {
    title?: string
    category?: string
    status?: ProjectStatus
    tactical_focus?: string
    aliases?: unknown
    notes?: string
  }

  const nextTitle = (body.title ?? project.title).trim()
  if (!nextTitle) {
    res.status(400).json({ error: 'title requerido' })
    return
  }

  const nextCategory = normalizeProjectKind(
    body.category ?? project.category ?? 'proyecto',
  )
  const nextStatus = normalizeStatus(
    body.status ?? project.status,
    'activo',
  )
  const nextFocus =
    body.tactical_focus !== undefined
      ? body.tactical_focus.trim() || null
      : project.tactical_focus
  const nextNotes =
    body.notes !== undefined ? body.notes.trim() || null : project.notes

  let aliasesJson = project.aliases || '[]'
  if (body.aliases !== undefined) {
    aliasesJson = parseAliases(body.aliases)
  }
  // conservar título original como alias si se renombra
  if (nextTitle !== project.title) {
    aliasesJson = mergeAliasJson(aliasesJson, [project.title])
  }

  const now = new Date().toISOString()
  db.prepare(
    `UPDATE projects
     SET title = ?, category = ?, status = ?, tactical_focus = ?, notes = ?,
         aliases = ?, source = 'manual', merged_into = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextTitle,
    nextCategory,
    nextStatus,
    nextFocus,
    nextNotes,
    aliasesJson,
    now,
    project.id,
  )

  syncProjectAliases(project.id, nextTitle, aliasesJson)
  enqueueEmbed(() => embedProject(project.id))

  const updated = rowRequired<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(project.id),
  )
  res.json({
    ok: true,
    project: {
      ...updated,
      category: nextCategory,
      aliases_list: aliasesList(updated),
    },
  })
})

projectsRouter.get('/:id', (req, res) => {
  const db = getDb()
  const project = row<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id),
  )
  if (!project) {
    res.status(404).json({ error: 'Proyecto no encontrado' })
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
         WHERE l.entity_kind = 'project' AND l.entity_id = ?
         ORDER BY l.created_at DESC`,
      )
      .all(project.id),
  )

  const people = rows<{
    id: string
    person_id: string
    project_id: string
    role: string
    created_at: string
    person_name: string
  }>(
    db
      .prepare(
        `SELECT pp.*, pe.name as person_name
         FROM person_project_links pp
         JOIN persons pe ON pe.id = pp.person_id
         WHERE pp.project_id = ?
         ORDER BY pp.created_at DESC`,
      )
      .all(project.id),
  )

  res.json({
    project: {
      ...project,
      category: normalizeProjectKind(project.category),
      aliases_list: aliasesList(project),
    },
    links,
    people,
  })
})

projectsRouter.post('/', (req, res) => {
  const {
    title,
    category,
    status = 'activo',
    tactical_focus,
    notes,
    aliases,
  } = req.body as {
    title?: string
    category?: string
    status?: ProjectStatus
    tactical_focus?: string
    notes?: string
    aliases?: unknown
  }

  if (!title?.trim()) {
    res.status(400).json({ error: 'title requerido' })
    return
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  const kind = normalizeProjectKind(category)
  const aliasesJson = parseAliases(aliases)
  const db = getDb()
  db.prepare(
    `INSERT INTO projects (
      id, title, category, status, tactical_focus, notes, aliases,
      created_at, updated_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  ).run(
    id,
    title.trim(),
    kind,
    normalizeStatus(status, 'activo'),
    tactical_focus?.trim() || null,
    notes?.trim() || null,
    aliasesJson,
    now,
    now,
  )

  syncProjectAliases(id, title.trim(), aliasesJson)
  enqueueEmbed(() => embedProject(id))

  const project = rowRequired<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id),
  )
  res.status(201).json({
    ok: true,
    project: {
      ...project,
      category: kind,
      aliases_list: aliasesList(project),
    },
  })
})

projectsRouter.patch('/:id', (req, res) => {
  const db = getDb()
  const existing = row<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(req.params.id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Proyecto no encontrado' })
    return
  }

  const { title, category, status, tactical_focus, notes, aliases } =
    req.body as {
      title?: string
      category?: string
      status?: ProjectStatus
      tactical_focus?: string
      notes?: string
      aliases?: unknown
    }

  const nextTitle = title?.trim() || existing.title
  const nextCategory =
    category !== undefined
      ? normalizeProjectKind(category)
      : normalizeProjectKind(existing.category)
  const nextStatus =
    status !== undefined
      ? normalizeStatus(status, existing.status as ProjectStatus)
      : (existing.status as ProjectStatus)
  const nextFocus =
    tactical_focus !== undefined
      ? tactical_focus.trim() || null
      : existing.tactical_focus
  const nextNotes = notes !== undefined ? notes.trim() || null : existing.notes
  const nextAliases =
    aliases !== undefined ? parseAliases(aliases) : existing.aliases || '[]'
  const now = new Date().toISOString()

  db.prepare(
    `UPDATE projects SET title = ?, category = ?, status = ?, tactical_focus = ?,
       notes = ?, aliases = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextTitle,
    nextCategory,
    nextStatus,
    nextFocus,
    nextNotes,
    nextAliases,
    now,
    existing.id,
  )

  syncProjectAliases(existing.id, nextTitle, nextAliases)
  enqueueEmbed(() => embedProject(existing.id))

  const project = rowRequired<Project>(
    db.prepare(`SELECT * FROM projects WHERE id = ?`).get(existing.id),
  )
  res.json({
    ok: true,
    project: {
      ...project,
      category: nextCategory,
      aliases_list: aliasesList(project),
    },
  })
})

projectsRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const existing = row<{ id: string }>(
    db.prepare(`SELECT id FROM projects WHERE id = ?`).get(req.params.id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Proyecto no encontrado' })
    return
  }

  db.exec('BEGIN')
  try {
    db.prepare(
      `DELETE FROM entity_links WHERE entity_kind = 'project' AND entity_id = ?`,
    ).run(existing.id)
    db.prepare(
      `DELETE FROM person_project_links WHERE project_id = ?`,
    ).run(existing.id)
    db.prepare(`DELETE FROM project_aliases WHERE project_id = ?`).run(
      existing.id,
    )
    removeProjectFts(existing.id)
    db.prepare(
      `DELETE FROM embeddings WHERE object_type = 'project' AND object_id = ?`,
    ).run(existing.id)
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(existing.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  res.json({ ok: true, id: existing.id })
})

projectsRouter.post('/proposals/:id/approve', (req, res) => {
  const db = getDb()
  const proposal = row<EntityProposal>(
    db
      .prepare(
        `SELECT * FROM entity_proposals WHERE id = ? AND kind = 'project'`,
      )
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
    title?: string
    category?: string
    status?: ProjectStatus
    tactical_focus?: string
    notes?: string
    matched_entity_id?: string
    as?: 'create' | 'link'
  }

  const meta = parseMeta(proposal.suggested_meta)
  const now = new Date().toISOString()
  const originalTitle = proposal.suggested_name
  const title = (body.title ?? originalTitle).trim()
  if (!title) {
    res.status(400).json({ error: 'title requerido' })
    return
  }

  const forceLink = body.as === 'link' || !!body.matched_entity_id
  const mode: 'create' | 'link' =
    forceLink || proposal.proposal_type === 'link' ? 'link' : 'create'

  let projectId: string

  db.exec('BEGIN')
  try {
    if (mode === 'create') {
      projectId = randomUUID()
      const kind = normalizeProjectKind(
        body.category ?? (meta.category as string) ?? 'proyecto',
      )
      db.prepare(
        `INSERT INTO projects (
          id, title, category, status, tactical_focus, notes, aliases,
          created_at, updated_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, 'extractor')`,
      ).run(
        projectId,
        title,
        kind,
        normalizeStatus(body.status ?? meta.status, 'emergente'),
        (
          body.tactical_focus ??
          (meta.tactical_focus as string | null) ??
          null
        )?.toString() || null,
        body.notes?.trim() || null,
        now,
        now,
      )
      syncProjectAliases(projectId, title, '[]')
    } else {
      projectId = body.matched_entity_id || proposal.matched_entity_id || ''
      if (!projectId) {
        throw new Error('matched_entity_id requerido para vincular')
      }
      const project = row<Project>(
        db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId),
      )
      if (!project) {
        throw new Error('Proyecto destino no encontrado')
      }

      const extras = [originalTitle, title].filter(
        (a) => a && a.toLowerCase() !== project.title.toLowerCase(),
      )
      const nextAliases = mergeAliasJson(project.aliases || '[]', extras)
      db.prepare(
        `UPDATE projects SET aliases = ?, updated_at = ? WHERE id = ?`,
      ).run(nextAliases, now, projectId)
      syncProjectAliases(projectId, project.title, nextAliases)
    }

    const nextMeta = JSON.stringify({
      ...meta,
      display_title: title,
      original_name: originalTitle,
      category: body.category ?? meta.category,
      status: body.status ?? meta.status,
      tactical_focus: body.tactical_focus ?? meta.tactical_focus,
      resolved_as: mode,
    })
    db.prepare(
      `UPDATE entity_proposals
       SET suggested_name = ?, suggested_meta = ?, status = 'approved',
           proposal_type = ?, matched_entity_id = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(title, nextMeta, mode, projectId, now, proposal.id)

    db.prepare(
      `UPDATE entry_entities_raw SET name = ?
       WHERE entry_id = ? AND name = ?
         AND type IN ('project', 'proyecto', 'tarea', 'reto', 'concepto')`,
    ).run(title, proposal.entry_id, originalTitle)

    const linkId = randomUUID()
    db.prepare(
      `INSERT INTO entity_links (id, entity_kind, entity_id, entry_id, quantomo_id, role, created_at)
       VALUES (?, 'project', ?, ?, NULL, 'mentioned', ?)`,
    ).run(linkId, projectId, proposal.entry_id, now)

    db.exec('COMMIT')

    const project = rowRequired<Project>(
      db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId),
    )
    const entry = row<{ title: string }>(
      db
        .prepare(`SELECT title FROM entries WHERE id = ?`)
        .get(proposal.entry_id),
    )
    const evidence = parseEvidence(proposal.evidence)

    enqueueEmbed(async () => {
      await embedProject(projectId)
      await embedLinkContext(
        linkId,
        'project',
        project.title,
        entry?.title ?? proposal.entry_id,
        evidence.snippet ?? '',
      )
    })

    res.json({
      ok: true,
      project_id: projectId,
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

projectsRouter.post('/proposals/:id/reject', (req, res) => {
  const db = getDb()
  const proposal = row<EntityProposal>(
    db
      .prepare(
        `SELECT * FROM entity_proposals WHERE id = ? AND kind = 'project'`,
      )
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

  db.prepare(
    `UPDATE entity_proposals SET status = 'rejected', resolved_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), proposal.id)

  res.json({ ok: true, proposal_id: proposal.id, status: 'rejected' })
})
