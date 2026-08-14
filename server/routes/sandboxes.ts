import { Router } from 'express'
import {
  addSandboxLink,
  addSandboxNode,
  createSandboxGraph,
  deleteSandboxGraph,
  deleteSandboxLink,
  deleteSandboxNode,
  getSandboxSnapshot,
  listSandboxGraphs,
  promoteSandboxLink,
  updateSandboxGraph,
  type SandboxLinkKind,
  type SandboxNodeKind,
} from '../services/sandboxes.js'

export const sandboxesRouter = Router()

function sendErr(res: import('express').Response, err: unknown): void {
  const status =
    err && typeof err === 'object' && 'status' in err
      ? Number((err as { status: number }).status) || 500
      : 500
  const message = err instanceof Error ? err.message : 'Error interno'
  res.status(status).json({ error: message })
}

sandboxesRouter.get('/', (_req, res) => {
  try {
    res.json({ graphs: listSandboxGraphs() })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.post('/', (req, res) => {
  try {
    const body = req.body as { name?: string; description?: string }
    const graph = createSandboxGraph({
      name: String(body.name ?? ''),
      description: body.description,
    })
    res.status(201).json({ graph })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.get('/:id', (req, res) => {
  try {
    const snapshot = getSandboxSnapshot(req.params.id)
    res.json(snapshot)
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.patch('/:id', (req, res) => {
  try {
    const body = req.body as { name?: string; description?: string }
    const graph = updateSandboxGraph(req.params.id, body)
    res.json({ graph })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.delete('/:id', (req, res) => {
  try {
    deleteSandboxGraph(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.post('/:id/nodes', (req, res) => {
  try {
    const body = req.body as {
      kind?: SandboxNodeKind
      label?: string
      ref_id?: string | null
      color?: string | null
      notes?: string
    }
    const kind = body.kind
    if (!kind) {
      res.status(400).json({ error: 'kind requerido' })
      return
    }
    const node = addSandboxNode(req.params.id, {
      kind,
      label: body.label,
      ref_id: body.ref_id,
      color: body.color,
      notes: body.notes,
    })
    res.status(201).json({ node })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.delete('/:id/nodes/:nodeId', (req, res) => {
  try {
    deleteSandboxNode(req.params.id, req.params.nodeId)
    res.json({ ok: true })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.post('/:id/links', (req, res) => {
  try {
    const body = req.body as {
      source_node_id?: string
      target_node_id?: string
      kind?: SandboxLinkKind
      label?: string
      quantomo_id?: string | null
    }
    const link = addSandboxLink(req.params.id, {
      source_node_id: String(body.source_node_id ?? ''),
      target_node_id: String(body.target_node_id ?? ''),
      kind: body.kind,
      label: body.label,
      quantomo_id: body.quantomo_id,
    })
    res.status(201).json({ link })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.delete('/:id/links/:linkId', (req, res) => {
  try {
    deleteSandboxLink(req.params.id, req.params.linkId)
    res.json({ ok: true })
  } catch (err) {
    sendErr(res, err)
  }
})

sandboxesRouter.post('/:id/links/:linkId/promote', (req, res) => {
  try {
    const result = promoteSandboxLink(req.params.id, req.params.linkId)
    res.json(result)
  } catch (err) {
    sendErr(res, err)
  }
})
