import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { getDb, syncPersonAliases, syncProjectAliases } from '../db.js'
import { row } from '../sql.js'
import {
  discoverLinks,
  dismissGraphLinkSuggestion,
  getGraphSnapshot,
  searchGraphNodes,
} from '../services/graph.js'
import { normalizePersonProjectRole } from '../services/entityRelations.js'
import { embedPerson, embedProject, enqueueEmbed } from '../services/embeddings.js'
import type { Person, Project } from '../types.js'

export const graphRouter = Router()

graphRouter.get('/', (req, res) => {
  const raw = req.query.suggestions
  const includeSuggestions =
    raw === undefined || raw === '1' || raw === 'true' || raw === 'yes'
  const snapshot = getGraphSnapshot({ includeSuggestions })
  res.json(snapshot)
})

graphRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const limitRaw =
    typeof req.query.limit === 'string' ? Number(req.query.limit) : 12
  const results = await searchGraphNodes(
    q,
    Number.isFinite(limitRaw) ? limitRaw : 12,
  )
  res.json({ query: q, results })
})

graphRouter.get('/discover', (req, res) => {
  const personId =
    typeof req.query.person_id === 'string' ? req.query.person_id.trim() : ''
  const projectId =
    typeof req.query.project_id === 'string' ? req.query.project_id.trim() : ''
  const limitRaw =
    typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined

  const suggestions = discoverLinks({
    person_id: personId || undefined,
    project_id: projectId || undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  })

  res.json({ suggestions, count: suggestions.length })
})

graphRouter.post('/dismiss', (req, res) => {
  const body = req.body as {
    person_id?: string
    project_id?: string
  }
  const personId = String(body.person_id ?? '').trim()
  const projectId = String(body.project_id ?? '').trim()
  if (!personId || !projectId) {
    res.status(400).json({ error: 'person_id y project_id requeridos' })
    return
  }

  const db = getDb()
  const person = row<Person>(
    db
      .prepare(
        `SELECT * FROM persons
         WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
      )
      .get(personId),
  )
  const project = row<Project>(
    db
      .prepare(
        `SELECT * FROM projects
         WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
      )
      .get(projectId),
  )
  if (!person || !project) {
    res.status(404).json({ error: 'Persona o proyecto no encontrado' })
    return
  }

  const result = dismissGraphLinkSuggestion(personId, projectId)
  res.json({
    ok: true,
    person_id: personId,
    project_id: projectId,
    created: result.created,
  })
})

graphRouter.post('/link-hitl', (req, res) => {
  const body = req.body as {
    person_id?: string
    project_id?: string
    role?: string
    alias?: string
    alias_target?: 'person' | 'project'
  }

  const personId = String(body.person_id ?? '').trim()
  const projectId = String(body.project_id ?? '').trim()
  if (!personId || !projectId) {
    res.status(400).json({ error: 'person_id y project_id requeridos' })
    return
  }

  const db = getDb()
  const person = row<Person>(
    db
      .prepare(
        `SELECT * FROM persons
         WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
      )
      .get(personId),
  )
  const project = row<Project>(
    db
      .prepare(
        `SELECT * FROM projects
         WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
      )
      .get(projectId),
  )
  if (!person || !project) {
    res.status(404).json({ error: 'Persona o proyecto no encontrado' })
    return
  }

  const role =
    body.role !== undefined && String(body.role).trim() !== ''
      ? normalizePersonProjectRole(body.role)
      : normalizePersonProjectRole('co_mentioned')

  const alias = String(body.alias ?? '').trim()
  const aliasTarget =
    body.alias_target === 'project' ? 'project' : ('person' as const)

  const existing = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM person_project_links
         WHERE person_id = ? AND project_id = ?`,
      )
      .get(personId, projectId),
  )
  if (existing) {
    res.status(409).json({ error: 'Ese vínculo persona↔proyecto ya existe' })
    return
  }

  const id = randomUUID()
  const now = new Date().toISOString()
  let aliasAdded: string | undefined
  let aliasesOut: string[] | undefined
  let reembedPerson = false
  let reembedProject = false

  db.exec('BEGIN')
  try {
    db.prepare(
      `INSERT INTO person_project_links (id, person_id, project_id, role, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, personId, projectId, role, now)

    if (alias) {
      if (aliasTarget === 'person') {
        let aliases: string[] = []
        try {
          aliases = JSON.parse(person.aliases || '[]') as string[]
        } catch {
          aliases = []
        }
        const lower = alias.toLowerCase()
        if (
          lower !== person.name.toLowerCase() &&
          !aliases.some((a) => a.toLowerCase() === lower)
        ) {
          aliases.push(alias)
          const aliasesJson = JSON.stringify(aliases)
          db.prepare(
            `UPDATE persons SET aliases = ?, updated_at = ? WHERE id = ?`,
          ).run(aliasesJson, now, person.id)
          syncPersonAliases(person.id, person.name, aliasesJson)
          aliasAdded = alias
          aliasesOut = aliases
          reembedPerson = true
        }
      } else {
        let aliases: string[] = []
        try {
          aliases = JSON.parse(project.aliases || '[]') as string[]
        } catch {
          aliases = []
        }
        const lower = alias.toLowerCase()
        if (
          lower !== project.title.toLowerCase() &&
          !aliases.some((a) => a.toLowerCase() === lower)
        ) {
          aliases.push(alias)
          const aliasesJson = JSON.stringify(aliases)
          db.prepare(
            `UPDATE projects SET aliases = ?, updated_at = ? WHERE id = ?`,
          ).run(aliasesJson, now, project.id)
          syncProjectAliases(project.id, project.title, aliasesJson)
          aliasAdded = alias
          aliasesOut = aliases
          reembedProject = true
        }
      }
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  if (reembedPerson) enqueueEmbed(() => embedPerson(person.id))
  if (reembedProject) enqueueEmbed(() => embedProject(project.id))

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
    alias_added: aliasAdded,
    aliases: aliasesOut,
  })
})
