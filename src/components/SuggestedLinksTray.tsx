import { useCallback, useEffect, useState } from 'react'
import { api } from '../services/api'
import type { GraphLinkSuggestion } from '../types'

interface Props {
  personId?: string | null
  projectId?: string | null
  refreshKey?: number
  onLinked?: () => void
}

export function SuggestedLinksTray({
  personId,
  projectId,
  refreshKey = 0,
  onLinked,
}: Props) {
  const [suggestions, setSuggestions] = useState<GraphLinkSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.discoverGraphLinks({
        person_id: personId || undefined,
        project_id: projectId || undefined,
        limit: 40,
      })
      setSuggestions(data.suggestions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar sugerencias')
    } finally {
      setLoading(false)
    }
  }, [personId, projectId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  function removeSuggestion(s: GraphLinkSuggestion) {
    setSuggestions((prev) =>
      prev.filter(
        (x) =>
          !(x.person_id === s.person_id && x.project_id === s.project_id),
      ),
    )
  }

  async function handleLink(s: GraphLinkSuggestion) {
    const key = `${s.person_id}:${s.project_id}`
    setBusyKey(key)
    setError(null)
    setFlash(null)
    try {
      await api.approveGraphLinkHitl({
        person_id: s.person_id,
        project_id: s.project_id,
        role: s.suggested_role || 'co_mentioned',
      })
      removeSuggestion(s)
      setFlash(`Vinculado: ${s.person_name} ↔ ${s.project_title}`)
      onLinked?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo vincular')
    } finally {
      setBusyKey(null)
    }
  }

  async function handleDismiss(s: GraphLinkSuggestion) {
    const key = `${s.person_id}:${s.project_id}`
    setBusyKey(key)
    setError(null)
    setFlash(null)
    try {
      await api.dismissGraphLinkSuggestion({
        person_id: s.person_id,
        project_id: s.project_id,
      })
      removeSuggestion(s)
      setFlash(`Descartado: ${s.person_name} ↔ ${s.project_title}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo descartar')
    } finally {
      setBusyKey(null)
    }
  }

  const contextual = Boolean(personId || projectId)

  return (
    <section className="panel entity-panel suggested-links-tray">
      <div className="panel-head entity-head">
        <div>
          <h2>Bandeja de Enlaces Sugeridos</h2>
          <p className="muted mono">
            Co-ocurrencia en audios
            {contextual ? ' · filtrado' : ' · global'}
            {suggestions.length > 0 ? ` · ${suggestions.length}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-tiny btn-ghost"
          disabled={loading}
          onClick={() => void load()}
        >
          Refrescar
        </button>
      </div>

      {flash && <p className="suggested-links-flash mono">{flash}</p>}
      {error && <p className="suggested-links-error mono">{error}</p>}

      {loading && suggestions.length === 0 ? (
        <p className="muted mono">Cargando…</p>
      ) : suggestions.length === 0 ? (
        <p className="muted mono">Sin enlaces sugeridos</p>
      ) : (
        <ul className="suggested-links-list">
          {suggestions.map((s) => {
            const key = `${s.person_id}:${s.project_id}`
            const busy = busyKey === key
            return (
              <li key={key} className="suggested-link-row">
                <div className="suggested-link-meta">
                  <span className="suggested-link-pair">
                    <strong>{s.person_name}</strong>
                    <span className="muted"> ↔ </span>
                    <strong>{s.project_title}</strong>
                  </span>
                  <span className="muted mono suggested-link-weight">
                    {s.shared_entry_count} entrada
                    {s.shared_entry_count === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="suggested-link-actions">
                  <button
                    type="button"
                    className="btn btn-tiny btn-primary"
                    disabled={busy || !!busyKey}
                    onClick={() => void handleLink(s)}
                  >
                    {busy ? '…' : 'Vincular'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-tiny btn-ghost suggested-link-dismiss"
                    disabled={busy || !!busyKey}
                    title="No vincular · dejar de sugerir"
                    aria-label={`Descartar sugerencia ${s.person_name} y ${s.project_title}`}
                    onClick={() => void handleDismiss(s)}
                  >
                    ×
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
