import { useCallback, useEffect, useRef, useState } from 'react'
import { FreeZone } from './components/FreeZone'
import { CustomsPanel } from './components/CustomsPanel'
import { ValidatedSection } from './components/ValidatedSection'
import { PersonsSection } from './components/PersonsSection'
import { ProjectsSection } from './components/ProjectsSection'
import { QuantomosSection } from './components/QuantomosSection'
import { GraphSection } from './components/GraphSection'
import { api } from './services/api'

type View =
  | 'franca'
  | 'aduana'
  | 'validada'
  | 'personas'
  | 'proyectos'
  | 'quantomos'
  | 'grafo'

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [view, setView] = useState<View>('franca')
  const [hasPending, setHasPending] = useState(false)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [personPending, setPersonPending] = useState(0)
  const [projectPending, setProjectPending] = useState(0)
  const preferFreeZone = useRef(false)
  const sawPending = useRef(false)
  const sawRunning = useRef(false)

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const handleEmpty = useCallback(() => {
    // Aduana permanece visible; no forzar salida
    setHasPending(false)
  }, [])

  const checkPending = useCallback(async () => {
    try {
      const [aduana, persons, projects, pipe, roster, projectRoster] =
        await Promise.all([
          api.getPendingProposals(),
          api.getPendingPersons(),
          api.getPendingProjects(),
          api.getPipelineStatus(),
          api.listPersons().catch(() => null),
          api.listProjects().catch(() => null),
        ])
      const has = aduana.proposals.length > 0
      const running = pipe.running && !pipe.paused
      setHasPending(has)
      setPipelineRunning(running)
      const waiting = roster?.waiting_count ?? 0
      setPersonPending(persons.proposals.length + waiting)
      const projectWaiting = projectRoster?.waiting_count ?? 0
      setProjectPending(projects.proposals.length + projectWaiting)

      // Al arrancar el pipeline o aparecer pendientes → ir a Aduana
      if (
        (running && !sawRunning.current) ||
        (has && !sawPending.current)
      ) {
        if (!preferFreeZone.current) {
          setView('aduana')
        }
      }

      sawPending.current = has
      sawRunning.current = running
    } catch {
      /* keep current mode */
    }
  }, [])

  useEffect(() => {
    void checkPending()
  }, [checkPending, refreshKey])

  useEffect(() => {
    const id = window.setInterval(() => void checkPending(), 2000)
    return () => window.clearInterval(id)
  }, [checkPending])

  const navClass = (id: View) =>
    view === id ? 'btn btn-tiny is-nav-active' : 'btn btn-tiny'

  const aduanaHot = hasPending || pipelineRunning

  return (
    <div className={view === 'grafo' ? 'app-shell is-graph-mode' : 'app-shell'}>
      <header className="brand-bar">
        <div className="brand">
          <span className="brand-mark">◇</span>
          <h1>Deprocast</h1>
        </div>
        <nav className="brand-nav">
          <button
            type="button"
            className={navClass('franca')}
            onClick={() => {
              preferFreeZone.current = true
              setView('franca')
            }}
          >
            Zona franca
          </button>
          <button
            type="button"
            className={navClass('aduana')}
            onClick={() => {
              preferFreeZone.current = false
              setView('aduana')
            }}
          >
            Aduana
            {aduanaHot && (
              <span className="nav-badge">
                {pipelineRunning ? '●' : '!'}
              </span>
            )}
          </button>
          <button
            type="button"
            className={navClass('validada')}
            onClick={() => {
              preferFreeZone.current = true
              setView('validada')
            }}
          >
            Validada
          </button>
          <button
            type="button"
            className={navClass('personas')}
            onClick={() => setView('personas')}
          >
            Personas
            {personPending > 0 && (
              <span className="nav-badge">{personPending}</span>
            )}
          </button>
          <button
            type="button"
            className={navClass('proyectos')}
            onClick={() => setView('proyectos')}
          >
            Proyectos
            {projectPending > 0 && (
              <span className="nav-badge">{projectPending}</span>
            )}
          </button>
          <button
            type="button"
            className={navClass('quantomos')}
            onClick={() => {
              preferFreeZone.current = true
              setView('quantomos')
            }}
          >
            Quántomos
          </button>
          <button
            type="button"
            className={navClass('grafo')}
            onClick={() => setView('grafo')}
          >
            Grafo
          </button>
        </nav>
      </header>

      <main
        className={
          view === 'aduana'
            ? 'stage-aduana'
            : view === 'validada' || view === 'quantomos'
              ? 'stage-validada'
              : view === 'personas' || view === 'proyectos'
                ? 'stage-entity'
                : view === 'grafo'
                  ? 'stage-graph'
                  : 'stage-franca'
        }
      >
        {view === 'aduana' ? (
          <CustomsPanel
            refreshKey={refreshKey}
            onEmpty={handleEmpty}
            onChanged={bump}
          />
        ) : view === 'validada' ? (
          <ValidatedSection refreshKey={refreshKey} />
        ) : view === 'personas' ? (
          <PersonsSection refreshKey={refreshKey} onChanged={bump} />
        ) : view === 'proyectos' ? (
          <ProjectsSection refreshKey={refreshKey} onChanged={bump} />
        ) : view === 'quantomos' ? (
          <QuantomosSection refreshKey={refreshKey} />
        ) : view === 'grafo' ? (
          <GraphSection refreshKey={refreshKey} onChanged={bump} />
        ) : (
          <FreeZone
            onProcessed={() => {
              preferFreeZone.current = false
              setView('aduana')
              bump()
            }}
          />
        )}
      </main>
    </div>
  )
}
