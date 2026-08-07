import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../services/api'
import type { Quantomo } from '../types'
import { downloadJson } from '../utils/downloadJson'

interface Props {
  refreshKey: number
}

type QuantomoRow = Quantomo & {
  entry_title: string
  entry_status: string
  timestamp_exact: string | null
  original_filename: string | null
  entry_created_at: string
}

type SortMode = 'weight' | 'date' | 'title'

function formatTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function QuantomosSection({ refreshKey }: Props) {
  const [quantomos, setQuantomos] = useState<QuantomoRow[]>([])
  const [universes, setUniverses] = useState<
    Array<{ name: string; count: number }>
  >([])
  const [avgWeight, setAvgWeight] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [universeFilter, setUniverseFilter] = useState<string>('all')
  const [sortMode, setSortMode] = useState<SortMode>('weight')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listQuantomos()
      setQuantomos(data.quantomos)
      setUniverses(data.universes)
      setAvgWeight(data.avg_weight)
      setSelectedId((prev) =>
        prev && data.quantomos.some((q) => q.id === prev) ? prev : null,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar quántomos')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = quantomos
    if (universeFilter !== 'all') {
      list = list.filter(
        (item) =>
          (item.universe || 'sin universo').trim() === universeFilter,
      )
    }
    if (q) {
      list = list.filter((item) => {
        const hay = [
          item.title,
          item.content ?? '',
          item.entry_title,
          item.universe ?? '',
          item.original_filename ?? '',
        ]
          .join('\n')
          .toLowerCase()
        return hay.includes(q)
      })
    }
    const sorted = [...list]
    if (sortMode === 'weight') {
      sorted.sort(
        (a, b) => (b.hermetic_weight ?? -1) - (a.hermetic_weight ?? -1),
      )
    } else if (sortMode === 'date') {
      sorted.sort((a, b) => {
        const ta = a.timestamp_exact || a.entry_created_at
        const tb = b.timestamp_exact || b.entry_created_at
        return tb.localeCompare(ta)
      })
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'es'))
    }
    return sorted
  }, [quantomos, query, universeFilter, sortMode])

  const selected = useMemo(
    () => filtered.find((q) => q.id === selectedId) ?? null,
    [filtered, selectedId],
  )

  const handleExport = () => {
    if (filtered.length === 0) return
    const day = new Date().toISOString().slice(0, 10)
    downloadJson(`deprocast-quantomos-${day}.json`, {
      exported_at: new Date().toISOString(),
      source: 'deprocast-quantomos',
      count: filtered.length,
      avg_weight: avgWeight,
      universes,
      filter: { query, universe: universeFilter, sort: sortMode },
      quantomos: filtered.map((q) => ({
        id: q.id,
        title: q.title,
        content: q.content,
        hermetic_weight: q.hermetic_weight,
        universe: q.universe,
        entry_id: q.entry_id,
        entry_title: q.entry_title,
        timestamp_exact: q.timestamp_exact,
        original_filename: q.original_filename,
      })),
    })
  }

  return (
    <div className="entity-stage quantomos-stage">
      <section className="panel entity-panel">
        <div className="panel-head entity-head">
          <div>
            <h2>Quántomos</h2>
            <p className="muted mono">
              Unidades de sentido validadas
              {quantomos.length > 0 ? ` · ${quantomos.length}` : ''}
              {avgWeight != null ? ` · peso medio ${avgWeight}` : ''}
            </p>
          </div>
          <div className="entity-head-actions">
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              disabled={filtered.length === 0}
              onClick={handleExport}
            >
              Exportar
            </button>
            <button
              type="button"
              className="btn btn-tiny"
              onClick={() => void load()}
            >
              Recargar
            </button>
          </div>
        </div>

        <div className="quantomo-stats">
          {universes.slice(0, 8).map((u) => (
            <button
              key={u.name}
              type="button"
              className={
                universeFilter === u.name
                  ? 'filter-chip is-active'
                  : 'filter-chip'
              }
              onClick={() =>
                setUniverseFilter((cur) =>
                  cur === u.name ? 'all' : u.name,
                )
              }
            >
              {u.name} · {u.count}
            </button>
          ))}
          {universeFilter !== 'all' && (
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              onClick={() => setUniverseFilter('all')}
            >
              Todos
            </button>
          )}
        </div>

        <div className="profiles-toolbar">
          <label className="semantic-search">
            <span className="mono">Buscar</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Título, contenido, fuente…"
            />
          </label>
          <div className="filter-rail" role="tablist" aria-label="Orden">
            {(
              [
                ['weight', 'Peso'],
                ['date', 'Fecha'],
                ['title', 'Título'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={sortMode === value}
                className={
                  sortMode === value ? 'filter-chip is-active' : 'filter-chip'
                }
                onClick={() => setSortMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {loading && quantomos.length === 0 ? (
          <p className="muted mono">Cargando…</p>
        ) : filtered.length === 0 ? (
          <p className="muted mono">
            {quantomos.length === 0
              ? 'Sin quántomos validados todavía'
              : 'Nada con este filtro'}
          </p>
        ) : (
          <div className="quantomo-layout">
            <ul className="quantomo-list">
              {filtered.map((q) => (
                <li key={q.id}>
                  <button
                    type="button"
                    className={
                      selectedId === q.id
                        ? 'quantomo-row is-active'
                        : 'quantomo-row'
                    }
                    onClick={() => setSelectedId(q.id)}
                  >
                    <span className="quantomo-row-title">{q.title}</span>
                    <span className="quantomo-row-meta mono">
                      w{q.hermetic_weight ?? '—'}
                      {q.universe ? ` · ${q.universe}` : ''}
                      {` · ${q.entry_title}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <aside className="quantomo-inspector">
              {!selected ? (
                <p className="muted mono">
                  Elegí un quántomo para leerlo en detalle
                </p>
              ) : (
                <>
                  <h3>{selected.title}</h3>
                  <p className="mono muted quantomo-inspector-meta">
                    peso {selected.hermetic_weight ?? '—'}
                    {selected.universe ? ` · universo ${selected.universe}` : ''}
                  </p>
                  <p className="mono muted">
                    Fuente · {selected.entry_title}
                    {selected.original_filename
                      ? ` · ${selected.original_filename}`
                      : ''}
                  </p>
                  <p className="mono muted">
                    {formatTs(selected.timestamp_exact || selected.entry_created_at)}
                  </p>
                  <div className="quantomo-body">
                    {selected.content?.trim() ? (
                      selected.content
                    ) : (
                      <span className="muted">Sin contenido</span>
                    )}
                  </div>
                </>
              )}
            </aside>
          </div>
        )}

        {error && <p className="status-line err">{error}</p>}
      </section>
    </div>
  )
}
