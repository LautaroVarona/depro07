import { useEffect, useState } from 'react'
import { PersonsSection } from './PersonsSection'
import { ProjectsSection } from './ProjectsSection'
import { api } from '../services/api'

export type EntityHubMode = 'perfiles' | 'agrupaciones' | 'proyectos'

interface Props {
  refreshKey: number
  onChanged?: () => void
  personPending?: number
  projectPending?: number
  initialMode?: EntityHubMode
}

export function EntityHub({
  refreshKey,
  onChanged,
  personPending = 0,
  projectPending = 0,
  initialMode = 'perfiles',
}: Props) {
  const [mode, setMode] = useState<EntityHubMode>(initialMode)
  const [agrupacionCount, setAgrupacionCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    void api
      .listAgrupaciones()
      .then((res) => {
        if (!cancelled) setAgrupacionCount(res.agrupaciones?.length ?? 0)
      })
      .catch(() => {
        /* ignore */
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  return (
    <div className="entity-stage personas-stage">
      <div
        className="personas-mode-switch"
        role="tablist"
        aria-label="Modo de vista"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'perfiles'}
          className={
            mode === 'perfiles' ? 'filter-chip is-active' : 'filter-chip'
          }
          onClick={() => setMode('perfiles')}
        >
          Perfiles
          {personPending > 0 ? (
            <span className="nav-badge">{personPending}</span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'agrupaciones'}
          className={
            mode === 'agrupaciones' ? 'filter-chip is-active' : 'filter-chip'
          }
          onClick={() => setMode('agrupaciones')}
        >
          Agrupaciones
          {agrupacionCount > 0 ? (
            <span className="nav-badge">{agrupacionCount}</span>
          ) : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'proyectos'}
          className={
            mode === 'proyectos' ? 'filter-chip is-active' : 'filter-chip'
          }
          onClick={() => setMode('proyectos')}
        >
          Proyectos
          {projectPending > 0 ? (
            <span className="nav-badge">{projectPending}</span>
          ) : null}
        </button>
      </div>

      {mode === 'proyectos' ? (
        <ProjectsSection
          refreshKey={refreshKey}
          onChanged={onChanged}
          embedded
        />
      ) : (
        <PersonsSection
          refreshKey={refreshKey}
          onChanged={onChanged}
          mode={mode}
          embedded
        />
      )}
    </div>
  )
}
