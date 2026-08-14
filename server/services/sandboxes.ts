import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { row, rows } from '../sql.js'
import { normalizePersonProjectRole } from './entityRelations.js'

export type SandboxNodeKind = 'freeform' | 'person' | 'project' | 'quantomo'
export type SandboxLinkKind = 'manual' | 'quantomo_bridge'

export interface SandboxGraphRow {
  id: string
  name: string
  description: string
  created_at: string
  updated_at: string
}

export interface SandboxNodeRow {
  id: string
  graph_id: string
  kind: SandboxNodeKind
  ref_id: string | null
  label: string
  color: string | null
  notes: string
  fx: number | null
  fy: number | null
  fz: number | null
  created_at: string
}

export interface SandboxLinkRow {
  id: string
  graph_id: string
  source_node_id: string
  target_node_id: string
  kind: SandboxLinkKind
  label: string
  quantomo_id: string | null
  promoted_at: string | null
  created_at: string
}

export interface SandboxSnapshot {
  graph: SandboxGraphRow
  nodes: SandboxNodeRow[]
  links: SandboxLinkRow[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function touchGraph(graphId: string, at = nowIso()): void {
  getDb()
    .prepare(`UPDATE sandbox_graphs SET updated_at = ? WHERE id = ?`)
    .run(at, graphId)
}

function getGraphOrThrow(id: string): SandboxGraphRow {
  const g = row<SandboxGraphRow>(
    getDb().prepare(`SELECT * FROM sandbox_graphs WHERE id = ?`).get(id),
  )
  if (!g) throw Object.assign(new Error('Grafo sandbox no encontrado'), { status: 404 })
  return g
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

export function listSandboxGraphs(): SandboxGraphRow[] {
  return rows<SandboxGraphRow>(
    getDb()
      .prepare(
        `SELECT * FROM sandbox_graphs ORDER BY updated_at DESC, created_at DESC`,
      )
      .all(),
  )
}

export function createSandboxGraph(input: {
  name: string
  description?: string
}): SandboxGraphRow {
  const name = input.name.trim()
  if (!name) throw Object.assign(new Error('name requerido'), { status: 400 })
  const id = randomUUID()
  const now = nowIso()
  const description = String(input.description ?? '').trim()
  getDb()
    .prepare(
      `INSERT INTO sandbox_graphs (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, name, description, now, now)
  return getGraphOrThrow(id)
}

export function updateSandboxGraph(
  id: string,
  input: { name?: string; description?: string },
): SandboxGraphRow {
  getGraphOrThrow(id)
  const now = nowIso()
  const db = getDb()
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (!name) throw Object.assign(new Error('name vacío'), { status: 400 })
    db.prepare(`UPDATE sandbox_graphs SET name = ?, updated_at = ? WHERE id = ?`).run(
      name,
      now,
      id,
    )
  }
  if (input.description !== undefined) {
    db.prepare(
      `UPDATE sandbox_graphs SET description = ?, updated_at = ? WHERE id = ?`,
    ).run(String(input.description), now, id)
  }
  if (input.name === undefined && input.description === undefined) {
    touchGraph(id, now)
  }
  return getGraphOrThrow(id)
}

export function deleteSandboxGraph(id: string): void {
  getGraphOrThrow(id)
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM sandbox_links WHERE graph_id = ?`).run(id)
    db.prepare(`DELETE FROM sandbox_nodes WHERE graph_id = ?`).run(id)
    db.prepare(`DELETE FROM sandbox_graphs WHERE id = ?`).run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function resolveCrmLabel(
  kind: SandboxNodeKind,
  refId: string,
): { label: string; color: string | null } | null {
  const db = getDb()
  if (kind === 'person') {
    const p = row<{ name: string }>(
      db
        .prepare(
          `SELECT name FROM persons
           WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
        )
        .get(refId),
    )
    return p ? { label: p.name, color: null } : null
  }
  if (kind === 'project') {
    const p = row<{ title: string }>(
      db
        .prepare(
          `SELECT title FROM projects
           WHERE id = ? AND (merged_into IS NULL OR merged_into = '')`,
        )
        .get(refId),
    )
    return p ? { label: p.title, color: null } : null
  }
  if (kind === 'quantomo') {
    const q = row<{ title: string }>(
      db.prepare(`SELECT title FROM quantomos WHERE id = ?`).get(refId),
    )
    return q ? { label: q.title, color: null } : null
  }
  return null
}

export function getSandboxSnapshot(graphId: string): SandboxSnapshot {
  const graph = getGraphOrThrow(graphId)
  const nodes = rows<SandboxNodeRow>(
    getDb()
      .prepare(
        `SELECT * FROM sandbox_nodes WHERE graph_id = ? ORDER BY created_at ASC`,
      )
      .all(graphId),
  ).map((n) => {
    if (n.kind !== 'freeform' && n.ref_id) {
      const resolved = resolveCrmLabel(n.kind, n.ref_id)
      if (resolved) return { ...n, label: resolved.label }
    }
    return n
  })
  const links = rows<SandboxLinkRow>(
    getDb()
      .prepare(
        `SELECT * FROM sandbox_links WHERE graph_id = ? ORDER BY created_at ASC`,
      )
      .all(graphId),
  )
  return { graph, nodes, links }
}

export function addSandboxNode(
  graphId: string,
  input: {
    kind: SandboxNodeKind
    label?: string
    ref_id?: string | null
    color?: string | null
    notes?: string
  },
): SandboxNodeRow {
  getGraphOrThrow(graphId)
  const kind = input.kind
  if (!['freeform', 'person', 'project', 'quantomo'].includes(kind)) {
    throw Object.assign(new Error('kind inválido'), { status: 400 })
  }

  const db = getDb()
  const now = nowIso()
  let label = String(input.label ?? '').trim()
  let refId: string | null = null

  if (kind === 'freeform') {
    if (!label) throw Object.assign(new Error('label requerido'), { status: 400 })
  } else {
    refId = String(input.ref_id ?? '').trim() || null
    if (!refId) {
      throw Object.assign(new Error('ref_id requerido para import CRM'), {
        status: 400,
      })
    }
    const existing = row<SandboxNodeRow>(
      db
        .prepare(
          `SELECT * FROM sandbox_nodes
           WHERE graph_id = ? AND kind = ? AND ref_id = ?`,
        )
        .get(graphId, kind, refId),
    )
    if (existing) return existing

    const resolved = resolveCrmLabel(kind, refId)
    if (!resolved) {
      throw Object.assign(new Error('Entidad CRM no encontrada'), { status: 404 })
    }
    label = resolved.label
  }

  const id = randomUUID()
  const color = input.color != null ? String(input.color) : null
  const notes = String(input.notes ?? '')

  try {
    db.prepare(
      `INSERT INTO sandbox_nodes
         (id, graph_id, kind, ref_id, label, color, notes, fx, fy, fz, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    ).run(id, graphId, kind, refId, label, color, notes, now)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE')) {
      throw Object.assign(new Error('Nodo ya existe en este grafo'), {
        status: 409,
      })
    }
    throw err
  }

  touchGraph(graphId, now)
  return rowRequiredNode(id)
}

function rowRequiredNode(id: string): SandboxNodeRow {
  const n = row<SandboxNodeRow>(
    getDb().prepare(`SELECT * FROM sandbox_nodes WHERE id = ?`).get(id),
  )
  if (!n) throw new Error('Nodo sandbox perdido tras insert')
  return n
}

export function deleteSandboxNode(graphId: string, nodeId: string): void {
  getGraphOrThrow(graphId)
  const db = getDb()
  const n = row<SandboxNodeRow>(
    db
      .prepare(`SELECT * FROM sandbox_nodes WHERE id = ? AND graph_id = ?`)
      .get(nodeId, graphId),
  )
  if (!n) throw Object.assign(new Error('Nodo no encontrado'), { status: 404 })

  db.exec('BEGIN')
  try {
    db.prepare(
      `DELETE FROM sandbox_links
       WHERE graph_id = ? AND (source_node_id = ? OR target_node_id = ?)`,
    ).run(graphId, nodeId, nodeId)
    db.prepare(`DELETE FROM sandbox_nodes WHERE id = ?`).run(nodeId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  touchGraph(graphId)
}

export function addSandboxLink(
  graphId: string,
  input: {
    source_node_id: string
    target_node_id: string
    kind?: SandboxLinkKind
    label?: string
    quantomo_id?: string | null
  },
): SandboxLinkRow {
  getGraphOrThrow(graphId)
  const db = getDb()
  const sourceId = String(input.source_node_id ?? '').trim()
  const targetId = String(input.target_node_id ?? '').trim()
  if (!sourceId || !targetId || sourceId === targetId) {
    throw Object.assign(new Error('source y target distintos requeridos'), {
      status: 400,
    })
  }

  const source = row<SandboxNodeRow>(
    db
      .prepare(`SELECT * FROM sandbox_nodes WHERE id = ? AND graph_id = ?`)
      .get(sourceId, graphId),
  )
  const target = row<SandboxNodeRow>(
    db
      .prepare(`SELECT * FROM sandbox_nodes WHERE id = ? AND graph_id = ?`)
      .get(targetId, graphId),
  )
  if (!source || !target) {
    throw Object.assign(new Error('Nodos no pertenecen a este grafo'), {
      status: 400,
    })
  }

  const kind: SandboxLinkKind =
    input.kind === 'quantomo_bridge' ? 'quantomo_bridge' : 'manual'
  let quantomoId: string | null =
    input.quantomo_id != null ? String(input.quantomo_id).trim() || null : null

  if (kind === 'quantomo_bridge') {
    if (!quantomoId) {
      // Allow using a quantomo node as the bridge source of truth
      if (source.kind === 'quantomo' && source.ref_id) quantomoId = source.ref_id
      else if (target.kind === 'quantomo' && target.ref_id)
        quantomoId = target.ref_id
    }
    if (!quantomoId) {
      throw Object.assign(
        new Error('quantomo_id requerido para puente quántomo'),
        { status: 400 },
      )
    }
    const q = row<{ id: string }>(
      db.prepare(`SELECT id FROM quantomos WHERE id = ?`).get(quantomoId),
    )
    if (!q) {
      throw Object.assign(new Error('Quántomo no encontrado'), { status: 404 })
    }
  }

  const [a, b] = canonicalPair(sourceId, targetId)
  const existing = row<SandboxLinkRow>(
    db
      .prepare(
        `SELECT * FROM sandbox_links
         WHERE graph_id = ? AND source_node_id = ? AND target_node_id = ?`,
      )
      .get(graphId, a, b),
  )
  if (existing) return existing

  const id = randomUUID()
  const now = nowIso()
  const label = String(input.label ?? '').trim()

  db.prepare(
    `INSERT INTO sandbox_links
       (id, graph_id, source_node_id, target_node_id, kind, label, quantomo_id, promoted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, graphId, a, b, kind, label, quantomoId, now)

  touchGraph(graphId, now)
  const link = row<SandboxLinkRow>(
    db.prepare(`SELECT * FROM sandbox_links WHERE id = ?`).get(id),
  )
  if (!link) throw new Error('Link sandbox perdido tras insert')
  return link
}

export function deleteSandboxLink(graphId: string, linkId: string): void {
  getGraphOrThrow(graphId)
  const db = getDb()
  const link = row<SandboxLinkRow>(
    db
      .prepare(`SELECT * FROM sandbox_links WHERE id = ? AND graph_id = ?`)
      .get(linkId, graphId),
  )
  if (!link) throw Object.assign(new Error('Arista no encontrada'), { status: 404 })
  db.prepare(`DELETE FROM sandbox_links WHERE id = ?`).run(linkId)
  touchGraph(graphId)
}

function ensureEntityLink(
  entityKind: 'person' | 'project',
  entityId: string,
  entryId: string,
  quantomoId: string,
  role: string,
): void {
  const db = getDb()
  const existing = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM entity_links
         WHERE entity_kind = ? AND entity_id = ? AND entry_id = ?
           AND (quantomo_id = ? OR quantomo_id IS NULL)`,
      )
      .get(entityKind, entityId, entryId, quantomoId),
  )
  if (existing) return
  db.prepare(
    `INSERT INTO entity_links
       (id, entity_kind, entity_id, entry_id, quantomo_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), entityKind, entityId, entryId, quantomoId, role, nowIso())
}

export function promoteSandboxLink(
  graphId: string,
  linkId: string,
): {
  ok: boolean
  already: boolean
  person_project_link_id: string | null
  link: SandboxLinkRow
} {
  getGraphOrThrow(graphId)
  const db = getDb()
  const link = row<SandboxLinkRow>(
    db
      .prepare(`SELECT * FROM sandbox_links WHERE id = ? AND graph_id = ?`)
      .get(linkId, graphId),
  )
  if (!link) throw Object.assign(new Error('Arista no encontrada'), { status: 404 })

  if (link.promoted_at) {
    return {
      ok: true,
      already: true,
      person_project_link_id: null,
      link,
    }
  }

  const source = row<SandboxNodeRow>(
    db.prepare(`SELECT * FROM sandbox_nodes WHERE id = ?`).get(link.source_node_id),
  )
  const target = row<SandboxNodeRow>(
    db.prepare(`SELECT * FROM sandbox_nodes WHERE id = ?`).get(link.target_node_id),
  )
  if (!source || !target) {
    throw Object.assign(new Error('Nodos de la arista no encontrados'), {
      status: 400,
    })
  }

  const ends = [source, target]
  const person = ends.find((n) => n.kind === 'person' && n.ref_id)
  const project = ends.find((n) => n.kind === 'project' && n.ref_id)
  if (!person?.ref_id || !project?.ref_id) {
    throw Object.assign(
      new Error('Solo se pueden promover aristas persona↔proyecto importadas'),
      { status: 400 },
    )
  }

  const personId = person.ref_id
  const projectId = project.ref_id
    const role = normalizePersonProjectRole(
      link.label || 'miembro',
    )
  const now = nowIso()

  let ppLinkId: string | null = null
  const existingPp = row<{ id: string }>(
    db
      .prepare(
        `SELECT id FROM person_project_links
         WHERE person_id = ? AND project_id = ?`,
      )
      .get(personId, projectId),
  )

  db.exec('BEGIN')
  try {
    if (existingPp) {
      ppLinkId = existingPp.id
    } else {
      ppLinkId = randomUUID()
      db.prepare(
        `INSERT INTO person_project_links (id, person_id, project_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(ppLinkId, personId, projectId, role, now)
    }

    if (link.kind === 'quantomo_bridge' && link.quantomo_id) {
      const q = row<{ id: string; entry_id: string | null }>(
        db
          .prepare(`SELECT id, entry_id FROM quantomos WHERE id = ?`)
          .get(link.quantomo_id),
      )
      if (q?.entry_id) {
        ensureEntityLink(
          'person',
          personId,
          q.entry_id,
          q.id,
          'sandbox_bridge',
        )
        ensureEntityLink(
          'project',
          projectId,
          q.entry_id,
          q.id,
          'sandbox_bridge',
        )
      }
    }

    db.prepare(
      `UPDATE sandbox_links SET promoted_at = ? WHERE id = ?`,
    ).run(now, linkId)

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  touchGraph(graphId, now)
  const updated = row<SandboxLinkRow>(
    db.prepare(`SELECT * FROM sandbox_links WHERE id = ?`).get(linkId),
  )!

  return {
    ok: true,
    already: false,
    person_project_link_id: ppLinkId,
    link: updated,
  }
}
