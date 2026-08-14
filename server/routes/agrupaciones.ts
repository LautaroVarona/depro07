import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { row, rowRequired, rows } from '../sql.js'
import type {
  Agrupacion,
  AgrupacionGeneratedMeta,
  AgrupacionMember,
  Person,
} from '../types.js'
import { extractAgrupacionMeta } from '../services/cohere.js'

export const agrupacionesRouter = Router()

function parseGeneratedMeta(raw: string | null | undefined): AgrupacionGeneratedMeta {
  try {
    const parsed = JSON.parse(raw || '{}') as Partial<AgrupacionGeneratedMeta>
    return {
      summary: String(parsed.summary ?? ''),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.map((t) => String(t))
        : [],
      themes: Array.isArray(parsed.themes)
        ? parsed.themes.map((t) => String(t))
        : [],
      related_person_names: Array.isArray(parsed.related_person_names)
        ? parsed.related_person_names.map((t) => String(t))
        : [],
      related_categories: Array.isArray(parsed.related_categories)
        ? parsed.related_categories.map((t) => String(t))
        : [],
      inferred_facts: Array.isArray(parsed.inferred_facts)
        ? parsed.inferred_facts.map((t) => String(t))
        : [],
    }
  } catch {
    return {
      summary: '',
      tags: [],
      themes: [],
      related_person_names: [],
      related_categories: [],
      inferred_facts: [],
    }
  }
}

function mapAgrupacion(a: Agrupacion) {
  return {
    ...a,
    member_count: a.member_count ?? 0,
    generated_meta_parsed: parseGeneratedMeta(a.generated_meta),
  }
}

function listMembers(agrupacionId: string): AgrupacionMember[] {
  const db = getDb()
  return rows<AgrupacionMember>(
    db
      .prepare(
        `SELECT m.id, m.agrupacion_id, m.person_id, m.created_at,
                p.name AS person_name, p.kind AS person_kind, p.source AS person_source
         FROM agrupacion_members m
         JOIN persons p ON p.id = m.person_id
         WHERE m.agrupacion_id = ?
         ORDER BY p.name COLLATE NOCASE ASC`,
      )
      .all(agrupacionId),
  )
}

agrupacionesRouter.get('/by-person/:personId', (req, res) => {
  const db = getDb()
  const personId = String(req.params.personId ?? '').trim()
  const list = rows<Agrupacion & { member_count: number }>(
    db
      .prepare(
        `SELECT a.*,
                (SELECT COUNT(*) FROM agrupacion_members m2
                 WHERE m2.agrupacion_id = a.id) AS member_count
         FROM agrupaciones a
         JOIN agrupacion_members m ON m.agrupacion_id = a.id
         WHERE m.person_id = ?
         ORDER BY a.name COLLATE NOCASE ASC`,
      )
      .all(personId),
  )
  res.json({ agrupaciones: list.map(mapAgrupacion) })
})

agrupacionesRouter.get('/', (_req, res) => {
  const db = getDb()
  const list = rows<Agrupacion & { member_count: number }>(
    db
      .prepare(
        `SELECT a.*,
                (SELECT COUNT(*) FROM agrupacion_members m
                 WHERE m.agrupacion_id = a.id) AS member_count
         FROM agrupaciones a
         ORDER BY a.name COLLATE NOCASE ASC`,
      )
      .all(),
  )
  res.json({ agrupaciones: list.map(mapAgrupacion) })
})

agrupacionesRouter.get('/:id', (req, res) => {
  const db = getDb()
  const a = row<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(req.params.id),
  )
  if (!a) {
    res.status(404).json({ error: 'Agrupación no encontrada' })
    return
  }
  const members = listMembers(a.id)
  res.json({
    agrupacion: mapAgrupacion({ ...a, member_count: members.length }),
    members,
  })
})

agrupacionesRouter.post('/', (req, res) => {
  const db = getDb()
  const body = req.body as { name?: string; notes?: string }
  const name = String(body.name ?? '').trim()
  if (!name) {
    res.status(400).json({ error: 'name requerido' })
    return
  }
  const notes =
    body.notes !== undefined ? String(body.notes).trim() || null : null
  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO agrupaciones (id, name, notes, generated_meta, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run(id, name, notes, now, now)

  const a = rowRequired<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(id),
  )
  res.status(201).json({
    ok: true,
    agrupacion: mapAgrupacion({ ...a, member_count: 0 }),
  })
})

agrupacionesRouter.patch('/:id', (req, res) => {
  const db = getDb()
  const existing = row<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(req.params.id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Agrupación no encontrada' })
    return
  }
  const body = req.body as { name?: string; notes?: string }
  const nextName =
    body.name !== undefined ? String(body.name).trim() : existing.name
  if (!nextName) {
    res.status(400).json({ error: 'name no puede quedar vacío' })
    return
  }
  const nextNotes =
    body.notes !== undefined
      ? String(body.notes).trim() || null
      : existing.notes
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE agrupaciones SET name = ?, notes = ?, updated_at = ? WHERE id = ?`,
  ).run(nextName, nextNotes, now, existing.id)

  const a = rowRequired<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(existing.id),
  )
  const count = row<{ c: number }>(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM agrupacion_members WHERE agrupacion_id = ?`,
      )
      .get(existing.id),
  )
  res.json({
    ok: true,
    agrupacion: mapAgrupacion({ ...a, member_count: count?.c ?? 0 }),
  })
})

agrupacionesRouter.delete('/:id', (req, res) => {
  const db = getDb()
  const existing = row<{ id: string }>(
    db.prepare(`SELECT id FROM agrupaciones WHERE id = ?`).get(req.params.id),
  )
  if (!existing) {
    res.status(404).json({ error: 'Agrupación no encontrada' })
    return
  }
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM agrupacion_members WHERE agrupacion_id = ?`).run(
      existing.id,
    )
    db.prepare(`DELETE FROM agrupaciones WHERE id = ?`).run(existing.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  res.json({ ok: true, id: existing.id })
})

agrupacionesRouter.post('/:id/members', (req, res) => {
  const db = getDb()
  const agrupacion = row<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(req.params.id),
  )
  if (!agrupacion) {
    res.status(404).json({ error: 'Agrupación no encontrada' })
    return
  }

  const personId = String(
    (req.body as { person_id?: string })?.person_id ?? '',
  ).trim()
  if (!personId) {
    res.status(400).json({ error: 'person_id requerido' })
    return
  }

  const person = row<Person>(
    db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId),
  )
  if (!person) {
    res.status(404).json({ error: 'Persona no encontrada' })
    return
  }
  if (person.merged_into || person.status === 'merged') {
    res.status(400).json({
      error: 'Esa entidad ya está fusionada; usá el perfil maestro',
    })
    return
  }
  if (person.status !== 'active' && person.status !== 'waiting') {
    res.status(400).json({ error: 'Persona no activa' })
    return
  }

  const already = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM agrupacion_members
         WHERE agrupacion_id = ? AND person_id = ?`,
      )
      .get(agrupacion.id, personId),
  )
  if (already) {
    res.status(409).json({ error: 'Ya es miembro de esta agrupación' })
    return
  }

  const now = new Date().toISOString()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO agrupacion_members (id, agrupacion_id, person_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, agrupacion.id, personId, now)
  db.prepare(`UPDATE agrupaciones SET updated_at = ? WHERE id = ?`).run(
    now,
    agrupacion.id,
  )

  const member = rowRequired<AgrupacionMember>(
    db
      .prepare(
        `SELECT m.id, m.agrupacion_id, m.person_id, m.created_at,
                p.name AS person_name, p.kind AS person_kind, p.source AS person_source
         FROM agrupacion_members m
         JOIN persons p ON p.id = m.person_id
         WHERE m.id = ?`,
      )
      .get(id),
  )
  res.status(201).json({ ok: true, member })
})

agrupacionesRouter.delete('/:id/members/:personId', (req, res) => {
  const db = getDb()
  const agrupacionId = String(req.params.id ?? '')
  const personId = String(req.params.personId ?? '')
  const existing = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM agrupacion_members
         WHERE agrupacion_id = ? AND person_id = ?`,
      )
      .get(agrupacionId, personId),
  )
  if (!existing) {
    res.status(404).json({ error: 'Membresía no encontrada' })
    return
  }
  db.prepare(`DELETE FROM agrupacion_members WHERE id = ?`).run(existing.id)
  db.prepare(`UPDATE agrupaciones SET updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    agrupacionId,
  )
  res.json({ ok: true, id: existing.id, person_id: personId })
})

agrupacionesRouter.post('/:id/process', async (req, res) => {
  const db = getDb()
  const agrupacion = row<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(req.params.id),
  )
  if (!agrupacion) {
    res.status(404).json({ error: 'Agrupación no encontrada' })
    return
  }

  const members = listMembers(agrupacion.id)
  const meta = await extractAgrupacionMeta({
    name: agrupacion.name,
    notes: agrupacion.notes ?? '',
    members: members.map((m) => m.person_name || m.person_id),
  })
  const now = new Date().toISOString()
  const metaJson = JSON.stringify(meta)
  db.prepare(
    `UPDATE agrupaciones SET generated_meta = ?, updated_at = ? WHERE id = ?`,
  ).run(metaJson, now, agrupacion.id)

  const a = rowRequired<Agrupacion>(
    db.prepare(`SELECT * FROM agrupaciones WHERE id = ?`).get(agrupacion.id),
  )
  res.json({
    ok: true,
    agrupacion: mapAgrupacion({ ...a, member_count: members.length }),
    members,
    generated_meta: meta,
  })
})
