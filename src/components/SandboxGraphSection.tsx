import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type LinkObject } from 'react-force-graph-2d'
import ForceGraph3D from 'react-force-graph-3d'
import { api } from '../services/api'
import type {
  SandboxLink,
  SandboxNode,
  SandboxSnapshot,
} from '../types'

interface Props {
  graphId: string
  refreshKey: number
  onChanged?: () => void
}

type ToolMode = 'select' | 'link' | 'bridge'
type ViewMode = '2d' | '3d'

type GNode = {
  id: string
  graph_id: string
  kind: SandboxNode['kind']
  ref_id: string | null
  label: string
  color: string | null
  notes: string
  created_at: string
  x?: number
  y?: number
  z?: number
  fx?: number
  fy?: number
  fz?: number
}

type GLink = SandboxLink & {
  source: string | GNode
  target: string | GNode
}

const KIND_COLOR: Record<SandboxNode['kind'], string> = {
  freeform: '#c4a574',
  person: '#7eb8da',
  project: '#d4a017',
  quantomo: '#c47a9e',
}

export function SandboxGraphSection({
  graphId,
  refreshKey,
  onChanged,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // force-graph refs are loosely typed across 2d/3d packages
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg2Ref = useRef<any>(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fg3Ref = useRef<any>(undefined)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [snapshot, setSnapshot] = useState<SandboxSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [tool, setTool] = useState<ToolMode>('select')
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [bridgeQuantomoId, setBridgeQuantomoId] = useState<string>('')
  const [freeLabel, setFreeLabel] = useState('')
  const [importQ, setImportQ] = useState('')
  const [importHits, setImportHits] = useState<
    Array<{ id: string; type: string; label: string; score: number }>
  >([])
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null)
  const [selectedLink, setSelectedLink] = useState<SandboxLink | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const snap = await api.getSandboxSnapshot(graphId)
      setSnapshot(snap)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar sandbox')
    } finally {
      setLoading(false)
    }
  }, [graphId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    setSelectedNode(null)
    setSelectedLink(null)
    setLinkFrom(null)
    setTool('select')
  }, [graphId])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(320, r.width), h: Math.max(240, r.height) })
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    setSize({ w: Math.max(320, r.width), h: Math.max(240, r.height) })
    return () => ro.disconnect()
  }, [])

  const graphData = useMemo(() => {
    if (!snapshot) return { nodes: [] as GNode[], links: [] as GLink[] }
    const nodes: GNode[] = snapshot.nodes.map((n) => ({
      id: n.id,
      graph_id: n.graph_id,
      kind: n.kind,
      ref_id: n.ref_id,
      label: n.label,
      color: n.color,
      notes: n.notes,
      created_at: n.created_at,
      fx: n.fx ?? undefined,
      fy: n.fy ?? undefined,
      fz: n.fz ?? undefined,
    }))
    const links: GLink[] = snapshot.links.map((l) => ({
      ...l,
      source: l.source_node_id,
      target: l.target_node_id,
    }))
    return { nodes, links }
  }, [snapshot])

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (viewMode === '2d') fg2Ref.current?.zoomToFit(400, 40)
      else fg3Ref.current?.zoomToFit(400, 40)
    }, 200)
    return () => window.clearTimeout(t)
  }, [graphData.nodes.length, viewMode, graphId])

  const nodeById = useMemo(() => {
    const m = new Map<string, SandboxNode>()
    for (const n of snapshot?.nodes ?? []) m.set(n.id, n)
    return m
  }, [snapshot])

  const canPromoteLink = useCallback(
    (link: SandboxLink | null): boolean => {
      if (!link || link.promoted_at) return false
      const a = nodeById.get(link.source_node_id)
      const b = nodeById.get(link.target_node_id)
      if (!a || !b) return false
      const kinds = new Set([a.kind, b.kind])
      return kinds.has('person') && kinds.has('project')
    },
    [nodeById],
  )

  const quantomoOptions = useMemo(() => {
    return (snapshot?.nodes ?? []).filter(
      (n) => n.kind === 'quantomo' && n.ref_id,
    )
  }, [snapshot])

  const paintNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const r = node.kind === 'quantomo' ? 6 : 8
      const color = node.color || KIND_COLOR[node.kind]
      ctx.beginPath()
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      if (selectedNode?.id === node.id || linkFrom === node.id) {
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2 / globalScale
        ctx.stroke()
      }
      const label = node.label
      if (globalScale > 0.55 && label) {
        ctx.font = `${11 / globalScale}px monospace`
        ctx.fillStyle = 'rgba(240,236,228,0.9)'
        ctx.textAlign = 'center'
        ctx.fillText(label.slice(0, 28), node.x ?? 0, (node.y ?? 0) + r + 10)
      }
    },
    [selectedNode, linkFrom],
  )

  const createLinkBetween = async (a: string, b: string) => {
    if (a === b) return
    setBusy(true)
    try {
      if (tool === 'bridge') {
        const qid =
          bridgeQuantomoId ||
          (nodeById.get(a)?.kind === 'quantomo'
            ? nodeById.get(a)?.ref_id
            : null) ||
          (nodeById.get(b)?.kind === 'quantomo'
            ? nodeById.get(b)?.ref_id
            : null)
        if (!qid) {
          setError('Elegí un quántomo para el puente')
          return
        }
        await api.addSandboxLink(graphId, {
          source_node_id: a,
          target_node_id: b,
          kind: 'quantomo_bridge',
          quantomo_id: qid,
        })
      } else {
        await api.addSandboxLink(graphId, {
          source_node_id: a,
          target_node_id: b,
          kind: 'manual',
        })
      }
      setLinkFrom(null)
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear arista')
    } finally {
      setBusy(false)
    }
  }

  const onNodeClick = (n: GNode) => {
    setSelectedLink(null)
    if (tool === 'link' || tool === 'bridge') {
      if (!linkFrom) {
        setLinkFrom(String(n.id))
        setSelectedNode(n)
        return
      }
      void createLinkBetween(linkFrom, String(n.id))
      setSelectedNode(n)
      return
    }
    setSelectedNode(n)
  }

  const onLinkClick = (l: GLink) => {
    setSelectedNode(null)
    const id = String(l.id)
    const full = snapshot?.links.find((x) => x.id === id) ?? null
    setSelectedLink(full)
  }

  const addFreeNode = async () => {
    const label = freeLabel.trim()
    if (!label) return
    setBusy(true)
    try {
      await api.addSandboxNode(graphId, { kind: 'freeform', label })
      setFreeLabel('')
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear nodo')
    } finally {
      setBusy(false)
    }
  }

  const runImportSearch = async () => {
    const q = importQ.trim()
    if (!q) {
      setImportHits([])
      return
    }
    try {
      let res = await api.searchGraphNodes(q, 10, { mode: 'lexical' })
      if (res.results.length === 0) {
        res = await api.searchGraphNodes(q, 10, { mode: 'semantic' })
      }
      setImportHits(
        res.results.filter((r) =>
          ['person', 'project', 'quantomo'].includes(r.type),
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de búsqueda')
    }
  }

  const importHit = async (hit: {
    id: string
    type: string
    label: string
  }) => {
    const kind = hit.type as 'person' | 'project' | 'quantomo'
    setBusy(true)
    try {
      await api.addSandboxNode(graphId, { kind, ref_id: hit.id })
      setImportHits([])
      setImportQ('')
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al importar')
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async () => {
    setBusy(true)
    try {
      if (selectedNode) {
        await api.deleteSandboxNode(graphId, selectedNode.id)
        setSelectedNode(null)
      } else if (selectedLink) {
        await api.deleteSandboxLink(graphId, selectedLink.id)
        setSelectedLink(null)
      }
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al borrar')
    } finally {
      setBusy(false)
    }
  }

  const promoteSelected = async () => {
    if (!selectedLink) return
    setBusy(true)
    try {
      await api.promoteSandboxLink(graphId, selectedLink.id)
      await load()
      onChanged?.()
      const snap = await api.getSandboxSnapshot(graphId)
      setSnapshot(snap)
      setSelectedLink(snap.links.find((l) => l.id === selectedLink.id) ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al promover')
    } finally {
      setBusy(false)
    }
  }

  const linkColor = (l: LinkObject) => {
    const link = l as GLink
    if (link.promoted_at) return 'rgba(120, 200, 140, 0.85)'
    if (link.kind === 'quantomo_bridge') return 'rgba(196, 122, 158, 0.8)'
    return 'rgba(200, 190, 170, 0.55)'
  }

  return (
    <div className="graph-universe sandbox-universe">
      <div className="graph-canvas-full" ref={wrapRef}>
        {loading && !snapshot ? (
          <p className="muted mono graph-empty">Cargando sandbox…</p>
        ) : graphData.nodes.length === 0 ? (
          <div className="graph-empty-state">
            <p className="mono">Sandbox vacío</p>
            <p className="muted mono">
              Agregá un nodo libre o importá del CRM para empezar.
            </p>
          </div>
        ) : viewMode === '2d' ? (
          <ForceGraph2D
            key="sandbox-2d"
            ref={fg2Ref}
            width={size.w}
            height={size.h}
            graphData={graphData}
            nodeId="id"
            backgroundColor="#0e0d0b"
            linkColor={linkColor}
            linkWidth={(l) => ((l as GLink).kind === 'quantomo_bridge' ? 2.2 : 1.2)}
            cooldownTicks={100}
            nodeCanvasObject={paintNode}
            onNodeClick={(n) => onNodeClick(n as GNode)}
            onLinkClick={(l) => onLinkClick(l as GLink)}
            onBackgroundClick={() => {
              setSelectedNode(null)
              setSelectedLink(null)
              if (tool !== 'select') setLinkFrom(null)
            }}
          />
        ) : (
          <ForceGraph3D
            key="sandbox-3d"
            ref={fg3Ref}
            width={size.w}
            height={size.h}
            graphData={graphData as never}
            nodeId="id"
            backgroundColor="#0e0d0b"
            nodeLabel="label"
            nodeColor={(n) => {
              const node = n as GNode
              return node.color || KIND_COLOR[node.kind]
            }}
            nodeVal={(n) => ((n as GNode).kind === 'quantomo' ? 2 : 4)}
            linkColor={linkColor}
            linkWidth={(l) => ((l as GLink).kind === 'quantomo_bridge' ? 2.2 : 1.2)}
            cooldownTicks={100}
            onNodeClick={(n) => onNodeClick(n as GNode)}
            onLinkClick={(l) => onLinkClick(l as GLink)}
            onBackgroundClick={() => {
              setSelectedNode(null)
              setSelectedLink(null)
              if (tool !== 'select') setLinkFrom(null)
            }}
          />
        )}

        <div className="sandbox-hud-top">
          <div className="sandbox-tools">
            {(
              [
                ['select', 'Seleccionar'],
                ['link', 'Unir'],
                ['bridge', 'Puente Q'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tool === id ? 'graph-hex-btn is-on' : 'graph-hex-btn'}
                onClick={() => {
                  setTool(id)
                  setLinkFrom(null)
                }}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={
                viewMode === '2d' ? 'graph-hex-btn is-on' : 'graph-hex-btn'
              }
              onClick={() => setViewMode('2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={
                viewMode === '3d' ? 'graph-hex-btn is-on' : 'graph-hex-btn'
              }
              onClick={() => setViewMode('3d')}
            >
              3D
            </button>
          </div>

          {tool === 'bridge' && (
            <select
              className="graph-cmd sandbox-select"
              value={bridgeQuantomoId}
              onChange={(e) => setBridgeQuantomoId(e.target.value)}
            >
              <option value="">Quántomo puente…</option>
              {quantomoOptions.map((q) => (
                <option key={q.id} value={q.ref_id ?? ''}>
                  {q.label}
                </option>
              ))}
            </select>
          )}

          {linkFrom && (tool === 'link' || tool === 'bridge') && (
            <span className="mono sandbox-hint">
              Click en el segundo nodo…
            </span>
          )}
        </div>

        <div className="sandbox-hud-compose">
          <form
            className="sandbox-compose-row"
            onSubmit={(e) => {
              e.preventDefault()
              void addFreeNode()
            }}
          >
            <input
              className="graph-cmd"
              value={freeLabel}
              onChange={(e) => setFreeLabel(e.target.value)}
              placeholder="Nodo libre…"
              disabled={busy}
            />
            <button type="submit" className="btn btn-tiny btn-primary" disabled={busy}>
              + Libre
            </button>
          </form>
          <form
            className="sandbox-compose-row"
            onSubmit={(e) => {
              e.preventDefault()
              void runImportSearch()
            }}
          >
            <input
              className="graph-cmd"
              value={importQ}
              onChange={(e) => setImportQ(e.target.value)}
              placeholder="Importar CRM…"
              disabled={busy}
            />
            <button type="submit" className="btn btn-tiny" disabled={busy}>
              Buscar
            </button>
          </form>
          {importHits.length > 0 && (
            <ul className="sandbox-import-hits">
              {importHits.map((h) => (
                <li key={`${h.type}:${h.id}`}>
                  <button
                    type="button"
                    className="btn btn-tiny btn-ghost"
                    onClick={() => void importHit(h)}
                  >
                    <span className="mono">{h.type}</span> {h.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {(selectedNode || selectedLink) && (
          <aside className="graph-drawer sandbox-drawer">
            {selectedNode && (
              <>
                <header>
                  <span className="mono">{selectedNode.kind}</span>
                  <h3>{selectedNode.label}</h3>
                </header>
                {selectedNode.ref_id && (
                  <p className="muted mono">ref {selectedNode.ref_id.slice(0, 8)}…</p>
                )}
                <div className="actions-row">
                  <button
                    type="button"
                    className="btn btn-tiny"
                    disabled={busy}
                    onClick={() => void deleteSelected()}
                  >
                    Borrar nodo
                  </button>
                </div>
              </>
            )}
            {selectedLink && (
              <>
                <header>
                  <span className="mono">{selectedLink.kind}</span>
                  <h3>Arista</h3>
                </header>
                <p className="muted mono">
                  {nodeById.get(selectedLink.source_node_id)?.label ?? '?'} ↔{' '}
                  {nodeById.get(selectedLink.target_node_id)?.label ?? '?'}
                </p>
                {selectedLink.quantomo_id && (
                  <p className="mono">Q {selectedLink.quantomo_id.slice(0, 8)}…</p>
                )}
                {selectedLink.promoted_at && (
                  <p className="mono">Promovida {selectedLink.promoted_at.slice(0, 10)}</p>
                )}
                <div className="actions-row">
                  {canPromoteLink(selectedLink) && (
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={busy}
                      onClick={() => void promoteSelected()}
                    >
                      Promover al corpus
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-tiny"
                    disabled={busy}
                    onClick={() => void deleteSelected()}
                  >
                    Borrar arista
                  </button>
                </div>
              </>
            )}
          </aside>
        )}

        {error && (
          <p className="graph-toast-error mono" role="alert">
            {error}
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              onClick={() => setError(null)}
            >
              ×
            </button>
          </p>
        )}

        {snapshot && (
          <div className="sandbox-title mono">
            {snapshot.graph.name} · {snapshot.nodes.length}n /{' '}
            {snapshot.links.length}e
          </div>
        )}
      </div>
    </div>
  )
}
