import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-2d'
import { api } from '../services/api'
import type {
  EntityLink,
  GraphLinkEvidence,
  GraphSnapshot,
  GraphVizLink,
  GraphVizNode,
  Person,
  PersonProjectLink,
  PersonRelation,
  Project,
} from '../types'
import {
  DEFAULT_COLORS,
  loadGraphSettings,
  saveGraphSettings,
  type GraphSettings,
} from '../lib/graphSettings'
import { SuggestedLinksTray } from './SuggestedLinksTray'

interface Props {
  refreshKey: number
  onChanged?: () => void
}

type GNode = NodeObject &
  GraphVizNode & {
    x?: number
    y?: number
    fx?: number | null
    fy?: number | null
  }

type GLink = LinkObject &
  GraphVizLink & {
    source: string | GNode
    target: string | GNode
  }

function nodeId(n: string | GNode): string {
  return typeof n === 'string' ? n : String(n.id)
}

function hexPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30)
    const px = x + r * Math.cos(a)
    const py = y + r * Math.sin(a)
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

function starPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  const spikes = 5
  const outer = r
  const inner = r * 0.42
  ctx.beginPath()
  for (let i = 0; i < spikes * 2; i++) {
    const rad = (Math.PI / spikes) * i - Math.PI / 2
    const rr = i % 2 === 0 ? outer : inner
    const px = x + Math.cos(rad) * rr
    const py = y + Math.sin(rad) * rr
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
}

function massRadius(mass: number, scale: number): number {
  return (5 + Math.sqrt(Math.max(0, mass)) * 2.6) * scale
}

function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null
  return iso.slice(0, 10)
}

function formatDay(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return d.toLocaleDateString('es-ES', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function buildHopSet(
  focusId: string,
  links: GLink[],
  hops: number,
): Set<string> {
  const adj = new Map<string, Set<string>>()
  for (const l of links) {
    if (l.kind === 'semantic') continue
    const s = nodeId(l.source)
    const t = nodeId(l.target)
    if (!adj.has(s)) adj.set(s, new Set())
    if (!adj.has(t)) adj.set(t, new Set())
    adj.get(s)!.add(t)
    adj.get(t)!.add(s)
  }
  const out = new Set<string>([focusId])
  let frontier = [focusId]
  for (let h = 0; h < hops; h++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (!out.has(n)) {
          out.add(n)
          next.push(n)
        }
      }
    }
    frontier = next
  }
  return out
}

function passesLayer(n: GraphVizNode, s: GraphSettings['layers']): boolean {
  if (n.type === 'person') {
    if (!s.showPersons) return false
    const k = String(n.kind ?? 'fisica')
    if (k === 'fisica' && !s.personFisica) return false
    if (k === 'juridica' && !s.personJuridica) return false
    if ((k === 'ficticia' || k === 'agrupacion') && !s.personFicticia) return false
    return true
  }
  if (n.type === 'project') {
    if (!s.showProjects) return false
    const k = String(n.kind ?? 'proyecto')
    if (k === 'proyecto' && !s.projectProyecto) return false
    if (k === 'tarea' && !s.projectTarea) return false
    if (k === 'concepto' && !s.projectConcepto) return false
    return true
  }
  if (n.type === 'quantomo') {
    if (!s.showQuantomos) return false
    const w = Number(n.hermetic_weight ?? 5)
    return w >= s.quantomoWeightMin && w <= s.quantomoWeightMax
  }
  if (n.type === 'orphan') return s.showOrphans
  return true
}

export function GraphSection({ refreshKey, onChanged }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined)
  const [size, setSize] = useState({ w: 900, h: 600 })
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<GraphSettings>(() =>
    loadGraphSettings(),
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(true)
  const [selected, setSelected] = useState<GNode | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverQuantomo, setHoverQuantomo] = useState<GNode | null>(null)
  const [timeDay, setTimeDay] = useState<string | null>(null)
  const [linkHud, setLinkHud] = useState<{
    x: number
    y: number
    link: GLink
  } | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [inspect, setInspect] = useState<{
    person?: Person
    project?: Project
    links: EntityLink[]
    relations?: PersonRelation[]
    projectLinks?: PersonProjectLink[]
    people?: PersonProjectLink[]
  } | null>(null)

  const layers = settings.layers
  const colors = settings.colors

  const patchSettings = useCallback((patch: Partial<GraphSettings>) => {
    setSettings((prev) => {
      const next = {
        layers: { ...prev.layers, ...(patch.layers ?? {}) },
        colors: { ...prev.colors, ...(patch.colors ?? {}) },
      }
      saveGraphSettings(next)
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getGraphSnapshot({
        suggestions: layers.showSuggestions,
      })
      setSnapshot(data)
      // Partir del último día con actividad real (heatmap), no de outliers
      const heat = data.heatmap ?? []
      if (heat.length > 0) {
        setTimeDay(heat[heat.length - 1]!.day)
      } else if (data.time_range.max) {
        setTimeDay(dayKey(data.time_range.max))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar el grafo')
    } finally {
      setLoading(false)
    }
  }, [layers.showSuggestions])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({
        w: Math.max(320, Math.floor(r.width)),
        h: Math.max(360, Math.floor(r.height)),
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const heatMax = useMemo(() => {
    if (!snapshot?.heatmap?.length) return 1
    return Math.max(1, ...snapshot.heatmap.map((h) => h.count))
  }, [snapshot])

  const graphData = useMemo(() => {
    if (!snapshot) return { nodes: [] as GNode[], links: [] as GLink[] }
    const day = timeDay
    const mode = layers.timeMode ?? 'growth'

    const nodes: GNode[] = snapshot.nodes
      .filter((n) => passesLayer(n, layers))
      .filter((n) => {
        if (!day) return true
        const a = dayKey(n.first_seen)
        const b = dayKey(n.last_seen) ?? a
        if (!a) return true // sin fecha → visible (no ocultar quántomos huérfanos de fecha)
        if (mode === 'momentum') {
          // Solo nodos activos ese día concreto
          return a <= day && (b ?? a) >= day
        }
        // growth (default): existía en o antes de esa fecha
        return a <= day
      })
      .map((n) => ({ ...n }))

    const alive = new Set(nodes.map((n) => n.id))
    const links: GLink[] = snapshot.links
      .filter((l) => {
        if (l.kind === 'suggested' && !layers.showSuggestions) return false
        if (!alive.has(l.source) || !alive.has(l.target)) return false
        if (!day || l.kind === 'semantic' || l.kind === 'orbit') return true
        const d = dayKey(l.created_at)
        return !d || d <= day
      })
      .map((l) => ({ ...l, source: l.source, target: l.target }))

    return { nodes, links }
  }, [snapshot, layers, timeDay])

  // Encadrar el grafo cuando hay datos
  useEffect(() => {
    if (!fgRef.current || graphData.nodes.length === 0) return
    const t = window.setTimeout(() => {
      try {
        fgRef.current?.zoomToFit(400, 60)
      } catch {
        /* ignore */
      }
    }, 350)
    return () => window.clearTimeout(t)
  }, [graphData.nodes.length, timeDay, layers.showQuantomos, layers.showPersons, layers.showProjects])

  const tunnel = useMemo(() => {
    if (selected && layers.focusMode) {
      return buildHopSet(String(selected.id), graphData.links, 2)
    }
    if (hoverId && !selected) {
      return buildHopSet(hoverId, graphData.links, 1)
    }
    return null
  }, [selected, layers.focusMode, hoverId, graphData.links])

  // Físicas
  useEffect(() => {
    const fg = fgRef.current
    if (!fg || graphData.nodes.length === 0) return

    const linkForce = fg.d3Force('link') as
      | {
          distance: (fn: (l: GLink) => number) => unknown
          strength: (fn: (l: GLink) => number) => unknown
        }
      | undefined

    const g = layers.linkGravity
    if (linkForce) {
      linkForce.distance((l: GLink) => {
        if (l.kind === 'orbit') return 28 + (12 - (l.weight ?? 5)) * 2
        const sim =
          typeof l.similarity === 'number'
            ? Math.max(0, Math.min(1, l.similarity))
            : l.kind === 'confirmed'
              ? 0.55
              : 0.3
        return (32 + (1 - sim) * 240) / Math.max(0.4, g)
      })
      linkForce.strength((l: GLink) => {
        if (l.kind === 'orbit') return 0.85
        if (l.kind === 'semantic') return (0.12 + (l.similarity ?? 0.4) * 0.5) * g
        if (l.kind === 'confirmed') return 0.5 * g
        return 0.22 * g
      })
    }

    const charge = fg.d3Force('charge') as
      | { strength: (v: number | ((n: GNode) => number)) => unknown }
      | undefined
    charge?.strength((n: GNode) => {
      const base = layers.chargeStrength
      if (n.type === 'quantomo') return base * 0.35
      if (n.type === 'orphan') return base * 0.5
      return base * (1 + Math.min(2, (n.mass ?? 1) / 20))
    })

    // God-mode: pin operator + anillos
    const opId = snapshot?.operator_id
    for (const n of graphData.nodes) {
      if (layers.godMode && opId && n.id === opId) {
        n.fx = 0
        n.fy = 0
      } else if (n.fx != null || n.fy != null) {
        n.fx = undefined
        n.fy = undefined
      }
    }

    if (layers.godMode && opId) {
      const opLinks = graphData.links.filter((l) => {
        const s = nodeId(l.source)
        const t = nodeId(l.target)
        return (
          (s === opId || t === opId) &&
          (l.kind === 'confirmed' || l.kind === 'semantic')
        )
      })
      const ring = new Map<string, number>()
      for (const l of opLinks) {
        const other = nodeId(l.source) === opId ? nodeId(l.target) : nodeId(l.source)
        const sim = l.similarity ?? 0.4
        const r = 80 + (1 - sim) * 280
        ring.set(other, r)
      }
      let i = 0
      for (const n of graphData.nodes) {
        const r = ring.get(String(n.id))
        if (r == null || n.id === opId) continue
        const ang = (i / Math.max(1, ring.size)) * Math.PI * 2
        n.fx = Math.cos(ang) * r
        n.fy = Math.sin(ang) * r
        i += 1
      }
    }

    fg.d3ReheatSimulation()
  }, [graphData, layers.chargeStrength, layers.linkGravity, layers.godMode, snapshot?.operator_id])

  const loadInspect = useCallback(async (n: GNode) => {
    setInspect(null)
    if (n.type === 'person') {
      try {
        const data = await api.getPerson(n.id)
        setInspect({
          person: data.person,
          links: data.links,
          relations: data.relations,
          projectLinks: data.project_links,
        })
      } catch {
        /* ignore */
      }
    } else if (n.type === 'project') {
      try {
        const data = await api.getProject(n.id)
        setInspect({
          project: data.project,
          links: data.links,
          people: data.people,
        })
      } catch {
        /* ignore */
      }
    } else {
      setInspect(null)
    }
  }, [])

  const paintNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const id = String(node.id)
      const scale = layers.nodeSizeScale
      const isQ = node.type === 'quantomo'
      const isOrphan = node.type === 'orphan' || Boolean(node.orphan)
      const r = isQ
        ? (3 + (Number(node.hermetic_weight ?? 5) / 12) * 7) * scale
        : massRadius(node.mass ?? 1, scale)
      const inTunnel = tunnel == null || tunnel.has(id)
      const selectedHere = selected?.id === id
      const fog = Boolean(node.fog) && !isOrphan
      const pulse = isOrphan ? 0.55 + 0.45 * Math.sin(Date.now() / 280) : 1

      if (!inTunnel) {
        ctx.globalAlpha = 0.1
        if (isQ) starPath(ctx, node.x ?? 0, node.y ?? 0, r)
        else hexPath(ctx, node.x ?? 0, node.y ?? 0, r)
        ctx.strokeStyle = colors.person
        ctx.lineWidth = 0.7 / globalScale
        ctx.stroke()
        ctx.globalAlpha = 1
        return
      }

      ctx.globalAlpha = (fog ? 0.5 : 1) * pulse
      if (isQ) starPath(ctx, node.x ?? 0, node.y ?? 0, r)
      else hexPath(ctx, node.x ?? 0, node.y ?? 0, r)

      if (isOrphan) ctx.fillStyle = colors.orphan
      else if (isQ) ctx.fillStyle = colors.quantomo
      else if (node.type === 'person') ctx.fillStyle = colors.person
      else ctx.fillStyle = colors.project
      ctx.fill()

      if (fog) {
        ctx.save()
        if (isQ) starPath(ctx, node.x ?? 0, node.y ?? 0, r)
        else hexPath(ctx, node.x ?? 0, node.y ?? 0, r)
        ctx.clip()
        ctx.fillStyle = colors.fog
        ctx.fillRect((node.x ?? 0) - r, (node.y ?? 0) - r, r * 2, r * 2)
        ctx.restore()
      }

      if (isQ) starPath(ctx, node.x ?? 0, node.y ?? 0, r)
      else hexPath(ctx, node.x ?? 0, node.y ?? 0, r)
      ctx.strokeStyle = selectedHere
        ? '#e8e4dc'
        : node.is_operator
          ? colors.person
          : 'rgba(0,0,0,0.35)'
      ctx.lineWidth = (selectedHere || node.is_operator ? 2.2 : 1) / globalScale
      ctx.stroke()
      ctx.globalAlpha = 1

      if (inTunnel && !isQ && globalScale > 0.5) {
        const fontSize = Math.max(9 / globalScale, 2.2)
        ctx.font = `${fontSize}px "IBM Plex Mono", ui-monospace, monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = '#e8e4dc'
        ctx.globalAlpha = fog ? 0.4 : 0.9
        ctx.fillText(
          (node.label || '').slice(0, 24),
          node.x ?? 0,
          (node.y ?? 0) + r + 2,
        )
        ctx.globalAlpha = 1
      }
    },
    [tunnel, selected, layers.nodeSizeScale, colors],
  )

  const linkVisibility = useCallback(
    (link: GLink) => link.kind !== 'semantic',
    [],
  )

  const linkColor = useCallback(
    (link: GLink) => {
      const s = nodeId(link.source)
      const t = nodeId(link.target)
      const active = tunnel == null || (tunnel.has(s) && tunnel.has(t))
      if (!active) return 'rgba(42,49,57,0.1)'
      if (link.kind === 'orbit') return colors.linkOrbit
      if (link.kind === 'suggested') return colors.linkSuggested
      return colors.linkConfirmed
    },
    [tunnel, colors],
  )

  const linkWidth = useCallback((link: GLink) => {
    if (link.kind === 'orbit') return 0.6
    if (link.kind === 'suggested') return 1
    return 1.4
  }, [])

  const linkLineDash = useCallback((link: GLink) => {
    if (link.kind === 'suggested') return [4, 3]
    if (link.kind === 'orbit') return [2, 4]
    return null
  }, [])

  const onLinkHover = useCallback((link: LinkObject | null) => {
    if (!link || (link as GLink).kind === 'semantic' || (link as GLink).kind === 'orbit') {
      setLinkHud(null)
      return
    }
    const g = link as GLink
    if (!g.evidence?.length) {
      setLinkHud(null)
      return
    }
    const s = g.source as GNode
    const t = g.target as GNode
    const wrap = wrapRef.current?.getBoundingClientRect()
    const fg = fgRef.current
    if (!wrap || !fg) {
      setLinkHud({ x: 24, y: 24, link: g })
      return
    }
    const mid = fg.graph2ScreenCoords(
      ((s.x ?? 0) + (t.x ?? 0)) / 2,
      ((s.y ?? 0) + (t.y ?? 0)) / 2,
    )
    setLinkHud({
      x: Math.min(wrap.width - 280, Math.max(8, mid.x + 12)),
      y: Math.min(wrap.height - 120, Math.max(8, mid.y + 12)),
      link: g,
    })
  }, [])

  const runSearch = useCallback(async () => {
    const q = searchQ.trim()
    if (!q) return
    setSearchBusy(true)
    try {
      const res = await api.searchGraphNodes(q, 10)
      const ids = new Set(res.results.map((r) => r.id))
      if (ids.size === 0) {
        setError('Sin clúster semántico para esa query')
        return
      }
      const nodes = graphData.nodes.filter((n) => ids.has(String(n.id)))
      if (nodes.length === 0) {
        setError('Hallazgos fuera de capas/filtro temporal')
        return
      }
      const top = res.results[0]
      const focus = graphData.nodes.find((n) => n.id === top?.id)
      if (focus) {
        setSelected(focus)
        void loadInspect(focus)
        setDrawerOpen(true)
      }
      fgRef.current?.zoomToFit(700, 80, (n) => ids.has(String((n as GNode).id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Búsqueda fallida')
    } finally {
      setSearchBusy(false)
    }
  }, [searchQ, graphData.nodes, loadInspect])

  const onNodeDragEnd = useCallback(
    async (node: NodeObject) => {
      const n = node as GNode
      if (!(n.type === 'orphan' || n.orphan) || n.type === 'quantomo') {
        // orphan person/project proposal OR waiting - only link if person orphan onto project
      }
      if (n.type !== 'orphan' && n.type !== 'person') return
      if (n.type === 'person' && !n.orphan) return

      // Find nearest project within threshold
      let best: GNode | null = null
      let bestD = 48
      for (const other of graphData.nodes) {
        if (other.type !== 'project') continue
        const dx = (n.x ?? 0) - (other.x ?? 0)
        const dy = (n.y ?? 0) - (other.y ?? 0)
        const d = Math.hypot(dx, dy)
        if (d < bestD) {
          bestD = d
          best = other
        }
      }
      if (!best) return

      // Only person↔project HITL for real person nodes
      if (n.type === 'person' && n.orphan !== true && n.source !== 'extractor') {
        try {
          await api.approveGraphLinkHitl({
            person_id: n.id,
            project_id: best.id,
            role: 'co_mentioned',
          })
          await load()
          onChanged?.()
        } catch {
          /* ignore */
        }
      }
    },
    [graphData.nodes, load, onChanged],
  )

  const timelineDays = useMemo(() => {
    if (!snapshot?.time_range.min || !snapshot.time_range.max) return []
    const min = Date.parse(snapshot.time_range.min)
    const max = Date.parse(snapshot.time_range.max)
    if (Number.isNaN(min) || Number.isNaN(max)) return []
    const heat = new Map(snapshot.heatmap.map((h) => [h.day, h.count]))
    const days: Array<{ day: string; count: number; ms: number }> = []
    const start = new Date(snapshot.time_range.min.slice(0, 10) + 'T12:00:00')
    const end = new Date(snapshot.time_range.max.slice(0, 10) + 'T12:00:00')
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10)
      days.push({ day: key, count: heat.get(key) ?? 0, ms: d.getTime() })
    }
    return days
  }, [snapshot])

  const timeIndex = useMemo(() => {
    if (!timeDay || timelineDays.length === 0) return timelineDays.length - 1
    const i = timelineDays.findIndex((d) => d.day === timeDay)
    return i >= 0 ? i : timelineDays.length - 1
  }, [timeDay, timelineDays])

  return (
    <div className="graph-universe">
      <div className="graph-canvas-full" ref={wrapRef}>
        {loading && !snapshot ? (
          <p className="muted mono graph-empty">Cargando universo…</p>
        ) : graphData.nodes.length === 0 ? (
          <div className="graph-empty-state">
            <p className="mono">Sin nodos visibles con el filtro actual.</p>
            <p className="muted mono">
              Probá: capas ON · modo crecimiento · mover el río del tiempo ·
              Refrescar
            </p>
            <div className="actions-row">
              <button
                type="button"
                className="btn btn-tiny btn-primary"
                onClick={() => {
                  patchSettings({
                    layers: {
                      ...layers,
                      showPersons: true,
                      showProjects: true,
                      showQuantomos: true,
                      timeMode: 'growth',
                      godMode: false,
                    },
                  })
                  if (snapshot?.heatmap?.length) {
                    setTimeDay(
                      snapshot.heatmap[snapshot.heatmap.length - 1]!.day,
                    )
                  } else {
                    setTimeDay(null)
                  }
                }}
              >
                Reset filtros
              </button>
              <button
                type="button"
                className="btn btn-tiny btn-ghost"
                onClick={() => void load()}
              >
                Refrescar
              </button>
            </div>
          </div>
        ) : (
          <ForceGraph2D
            ref={fgRef}
            width={size.w}
            height={size.h}
            graphData={graphData}
            nodeId="id"
            nodeVal={(n) => Math.max(1, (n as GNode).mass ?? 1)}
            backgroundColor={colors.bg}
            linkVisibility={linkVisibility}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLineDash={linkLineDash}
            cooldownTicks={140}
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={(node, color, ctx) => {
              const n = node as GNode
              const r =
                n.type === 'quantomo'
                  ? 8 * layers.nodeSizeScale
                  : massRadius(n.mass ?? 1, layers.nodeSizeScale) + 3
              ctx.fillStyle = color
              hexPath(ctx, node.x ?? 0, node.y ?? 0, r)
              ctx.fill()
            }}
            onNodeHover={(n) => {
              const node = n as GNode | null
              setHoverId(node ? String(node.id) : null)
              setHoverQuantomo(
                node && (node.type === 'quantomo' || node.type === 'orphan')
                  ? node
                  : null,
              )
            }}
            onNodeClick={(n) => {
              const node = n as GNode
              setSelected(node)
              setDrawerOpen(true)
              void loadInspect(node)
            }}
            onBackgroundClick={() => {
              setSelected(null)
              setLinkHud(null)
              setHoverQuantomo(null)
            }}
            onLinkHover={onLinkHover}
            onNodeDragEnd={onNodeDragEnd}
          />
        )}

        {/* HUD: capas */}
        <div className="graph-hud-layers">
          {(
            [
              ['showProjects', 'Proyectos'],
              ['projectTarea', 'Tareas'],
              ['showPersons', 'Personas'],
              ['showQuantomos', 'Quántomos'],
              ['showOrphans', 'Huérfanos'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={
                layers[key]
                  ? 'graph-hex-btn is-on'
                  : 'graph-hex-btn'
              }
              onClick={() =>
                patchSettings({
                  layers: { ...layers, [key]: !layers[key] },
                })
              }
            >
              {label}
            </button>
          ))}
        </div>

        {/* HUD: command palette */}
        <form
          className="graph-hud-search"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch()
          }}
        >
          <input
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder="GraphRAG · planes de igualdad…"
            className="graph-cmd"
          />
          <button
            type="submit"
            className="btn btn-tiny btn-primary"
            disabled={searchBusy}
          >
            {searchBusy ? '…' : 'Ir'}
          </button>
        </form>

        {/* HUD: tools */}
        <div className="graph-hud-tools">
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            onClick={() =>
              patchSettings({
                layers: { ...layers, godMode: !layers.godMode },
              })
            }
          >
            {layers.godMode ? 'God-mode ON' : 'God-mode'}
          </button>
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            onClick={() => setSettingsOpen((o) => !o)}
          >
            Settings
          </button>
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            onClick={() => setDrawerOpen((o) => !o)}
          >
            {drawerOpen ? 'Ocultar panel' : 'Panel'}
          </button>
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            disabled={loading}
            onClick={() => void load()}
          >
            Refrescar
          </button>
        </div>

        {error && <p className="graph-toast-error mono">{error}</p>}

        {linkHud && (
          <aside
            className="graph-link-hud"
            style={{ left: linkHud.x, top: linkHud.y }}
          >
            <header className="graph-link-hud-head mono">
              Evidencia
              {typeof linkHud.link.similarity === 'number'
                ? ` · cos ${linkHud.link.similarity.toFixed(2)}`
                : ''}
            </header>
            <ul className="graph-link-hud-list">
              {(linkHud.link.evidence as GraphLinkEvidence[]).map((ev) => (
                <li key={ev.entry_id}>
                  <strong className="mono">{ev.title}</strong>
                  <p>
                    {ev.snippet
                      ? `“${ev.snippet}${ev.snippet.length >= 220 ? '…' : ''}”`
                      : 'Sin transcripción'}
                  </p>
                </li>
              ))}
            </ul>
          </aside>
        )}

        {hoverQuantomo && (
          <aside className="graph-quantomo-pop">
            <header className="mono">
              {hoverQuantomo.type === 'orphan' ? 'Huérfano' : 'Quántomo'}
              {hoverQuantomo.hermetic_weight != null
                ? ` · peso ${hoverQuantomo.hermetic_weight}`
                : ''}
            </header>
            <strong>{hoverQuantomo.label}</strong>
            <p>{hoverQuantomo.content || 'Sin contenido'}</p>
          </aside>
        )}
      </div>

      {/* Timeline scrubber — fondo de pantalla */}
      {timelineDays.length > 1 && (
        <div className="graph-river">
          <div className="graph-river-heat" aria-hidden>
            {timelineDays.map((d) => (
              <span
                key={d.day}
                className="graph-river-bar"
                style={{
                  opacity: 0.15 + (d.count / heatMax) * 0.85,
                  height: `${12 + (d.count / heatMax) * 28}px`,
                }}
                title={`${d.day}: ${d.count} quántomos`}
              />
            ))}
          </div>
          <div className="graph-river-controls">
            <span className="mono">{formatDay(timelineDays[0]?.day ?? null)}</span>
            <input
              type="range"
              className="graph-time-slider"
              min={0}
              max={Math.max(0, timelineDays.length - 1)}
              value={timeIndex}
              onChange={(e) => {
                const i = Number(e.target.value)
                setTimeDay(timelineDays[i]?.day ?? null)
              }}
              aria-label="Río del tiempo"
            />
            <span className="mono">
              {formatDay(timeDay)}
            </span>
          </div>
        </div>
      )}

      {/* Drawer derecho */}
      {drawerOpen && (
        <aside
          className="graph-drawer"
          style={{ background: colors.hud }}
        >
          {selected && (selected.type === 'person' || selected.type === 'project') ? (
            <div className="graph-inspect">
              <header className="panel-head entity-head">
                <div>
                  <h2>{selected.label}</h2>
                  <p className="muted mono">
                    {selected.type} · {selected.kind ?? '—'} ·{' '}
                    {selected.status ?? '—'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-tiny btn-ghost"
                  onClick={() => setSelected(null)}
                >
                  ×
                </button>
              </header>
              {(selected.aliases?.length ?? 0) > 0 && (
                <p className="mono graph-inspect-aliases">
                  aliases: {selected.aliases!.join(', ')}
                </p>
              )}
              {inspect?.person && (
                <p className="muted">{inspect.person.notes}</p>
              )}
              {inspect?.project && (
                <p className="muted">
                  {inspect.project.tactical_focus || inspect.project.notes}
                </p>
              )}
              <h4 className="mono">Menciones</h4>
              <ul className="graph-chrono">
                {(inspect?.links ?? []).slice(0, 24).map((l) => (
                  <li key={l.id}>
                    <span className="mono">
                      {formatDay(l.timestamp_exact ?? l.created_at)}
                    </span>
                    <span>{l.entry_title ?? l.entry_id}</span>
                  </li>
                ))}
                {(inspect?.links?.length ?? 0) === 0 && (
                  <li className="muted mono">Sin menciones cargadas</li>
                )}
              </ul>
              {inspect?.projectLinks && inspect.projectLinks.length > 0 && (
                <>
                  <h4 className="mono">Proyectos</h4>
                  <ul className="graph-chrono">
                    {inspect.projectLinks.map((pl) => (
                      <li key={pl.id}>
                        {pl.project_title} · {pl.role}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {inspect?.people && inspect.people.length > 0 && (
                <>
                  <h4 className="mono">Personas</h4>
                  <ul className="graph-chrono">
                    {inspect.people.map((pe) => (
                      <li key={pe.id}>
                        {pe.person_name} · {pe.role}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : selected && (selected.type === 'quantomo' || selected.type === 'orphan') ? (
            <div className="graph-inspect">
              <header className="panel-head entity-head">
                <div>
                  <h2>{selected.label}</h2>
                  <p className="muted mono">
                    {selected.type}
                    {selected.hermetic_weight != null
                      ? ` · peso ${selected.hermetic_weight}`
                      : ''}
                    {selected.universe ? ` · ${selected.universe}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-tiny btn-ghost"
                  onClick={() => setSelected(null)}
                >
                  ×
                </button>
              </header>
              <p>{selected.content || 'Sin contenido'}</p>
            </div>
          ) : (
            <SuggestedLinksTray
              refreshKey={refreshKey}
              onLinked={() => {
                void load()
                onChanged?.()
              }}
            />
          )}
        </aside>
      )}

      {/* Settings panel */}
      {settingsOpen && (
        <div className="graph-settings">
          <header className="panel-head entity-head">
            <h2>Settings del grafo</h2>
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              onClick={() => setSettingsOpen(false)}
            >
              ×
            </button>
          </header>

          <fieldset>
            <legend className="mono">Personas</legend>
            {(
              [
                ['personFisica', 'Físicas'],
                ['personJuridica', 'Jurídicas'],
                ['personFicticia', 'Ficticias'],
              ] as const
            ).map(([k, lab]) => (
              <label key={k} className="graph-toggle">
                <input
                  type="checkbox"
                  checked={layers[k]}
                  onChange={(e) =>
                    patchSettings({
                      layers: { ...layers, [k]: e.target.checked },
                    })
                  }
                />
                {lab}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className="mono">Proyectos</legend>
            {(
              [
                ['projectProyecto', 'Proyectos'],
                ['projectTarea', 'Tareas'],
                ['projectConcepto', 'Conceptos'],
              ] as const
            ).map(([k, lab]) => (
              <label key={k} className="graph-toggle">
                <input
                  type="checkbox"
                  checked={layers[k]}
                  onChange={(e) =>
                    patchSettings({
                      layers: { ...layers, [k]: e.target.checked },
                    })
                  }
                />
                {lab}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend className="mono">Quántomos · peso {layers.quantomoWeightMin}–{layers.quantomoWeightMax}</legend>
            <label className="graph-toggle">
              Min
              <input
                type="range"
                min={1}
                max={12}
                value={layers.quantomoWeightMin}
                onChange={(e) =>
                  patchSettings({
                    layers: {
                      ...layers,
                      quantomoWeightMin: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="graph-toggle">
              Max
              <input
                type="range"
                min={1}
                max={12}
                value={layers.quantomoWeightMax}
                onChange={(e) =>
                  patchSettings({
                    layers: {
                      ...layers,
                      quantomoWeightMax: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend className="mono">Físicas</legend>
            <label className="graph-toggle">
              Tamaño nodos
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={layers.nodeSizeScale}
                onChange={(e) =>
                  patchSettings({
                    layers: {
                      ...layers,
                      nodeSizeScale: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="graph-toggle">
              Repulsión (Coulomb)
              <input
                type="range"
                min={-400}
                max={-40}
                step={10}
                value={layers.chargeStrength}
                onChange={(e) =>
                  patchSettings({
                    layers: {
                      ...layers,
                      chargeStrength: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="graph-toggle">
              Gravedad / atracción
              <input
                type="range"
                min={0.3}
                max={2}
                step={0.05}
                value={layers.linkGravity}
                onChange={(e) =>
                  patchSettings({
                    layers: {
                      ...layers,
                      linkGravity: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label className="graph-toggle">
              <input
                type="checkbox"
                checked={layers.focusMode}
                onChange={(e) =>
                  patchSettings({
                    layers: { ...layers, focusMode: e.target.checked },
                  })
                }
              />
              Túnel (focus)
            </label>
            <label className="graph-toggle">
              <input
                type="checkbox"
                checked={(layers.timeMode ?? 'growth') === 'momentum'}
                onChange={(e) =>
                  patchSettings({
                    layers: {
                      ...layers,
                      timeMode: e.target.checked ? 'momentum' : 'growth',
                    },
                  })
                }
              />
              Momentum estricto (solo nodos activos ese día)
            </label>
            <label className="graph-toggle">
              <input
                type="checkbox"
                checked={layers.showSuggestions}
                onChange={(e) =>
                  patchSettings({
                    layers: { ...layers, showSuggestions: e.target.checked },
                  })
                }
              />
              Aristas sugeridas
            </label>
          </fieldset>

          <fieldset>
            <legend className="mono">Colores (permanentes)</legend>
            {(
              [
                ['person', 'Persona'],
                ['project', 'Proyecto'],
                ['quantomo', 'Quántomo'],
                ['orphan', 'Huérfano'],
                ['bg', 'Fondo'],
                ['hud', 'HUD'],
              ] as const
            ).map(([k, lab]) => (
              <label key={k} className="graph-color-row">
                <span>{lab}</span>
                <input
                  type="color"
                  value={
                    colors[k].startsWith('#')
                      ? colors[k].slice(0, 7)
                      : DEFAULT_COLORS[k].slice(0, 7)
                  }
                  onChange={(e) =>
                    patchSettings({
                      colors: { ...colors, [k]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              onClick={() =>
                patchSettings({ colors: { ...DEFAULT_COLORS } })
              }
            >
              Reset colores
            </button>
          </fieldset>
        </div>
      )}
    </div>
  )
}
