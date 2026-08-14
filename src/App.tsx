import { useCallback, useEffect, useRef, useState } from 'react'
import { FreeZone } from './components/FreeZone'
import { CustomsPanel } from './components/CustomsPanel'
import { ValidatedSection } from './components/ValidatedSection'
import { EntityHub } from './components/EntityHub'
import { QuantomosSection } from './components/QuantomosSection'
import { GraphWorkspace } from './components/GraphWorkspace'
import { CribaPanel } from './components/CribaPanel'
import { BibliotecaSection } from './components/BibliotecaSection'
import { ChatsSection } from './components/ChatsSection'
import { RespaldoSection } from './components/RespaldoSection'
import { FeedbackWidget } from './components/FeedbackWidget'
import { api } from './services/api'

type View =
  | 'franca'
  | 'aduana'
  | 'validada'
  | 'entidades'
  | 'quantomos'
  | 'grafo'
  | 'criba'
  | 'biblioteca'
  | 'chats'
  | 'respaldo'

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
  const checkInFlight = useRef(false)

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  const handleEmpty = useCallback(() => {
    // Aduana permanece visible; no forzar salida
    setHasPending(false)
  }, [])

  const checkPending = useCallback(async () => {
    if (checkInFlight.current) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return
    }
    checkInFlight.current = true
    try {
      const [aduana, criba, pipe, roster, projectRoster] = await Promise.all([
        api.getPendingProposals(),
        api.getCribaAudios().catch(() => ({ entries: [] })),
        api.getPipelineStatus(),
        api.listPersons().catch(() => null),
        api.listProjects().catch(() => null),
      ])
      const has = aduana.proposals.length > 0 || criba.entries.length > 0
      const running = pipe.running && !pipe.paused
      setHasPending(has)
      setPipelineRunning(running)
      const waiting = roster?.waiting_count ?? 0
      const personNer = roster?.pending_proposals_count ?? 0
      setPersonPending(personNer + waiting)
      const projectWaiting = projectRoster?.waiting_count ?? 0
      const projectNer = projectRoster?.pending_proposals_count ?? 0
      setProjectPending(projectNer + projectWaiting)

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
    } finally {
      checkInFlight.current = false
    }
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => void checkPending(), 320)
    return () => window.clearTimeout(t)
  }, [checkPending, refreshKey])

  useEffect(() => {
    const id = window.setInterval(() => void checkPending(), 5000)
    const onVis = () => {
      if (document.visibilityState === 'visible') void checkPending()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [checkPending])

  const navClass = (id: View) =>
    view === id ? 'btn btn-tiny is-nav-active' : 'btn btn-tiny'

  const aduanaHot = hasPending || pipelineRunning
  const entityPending = personPending + projectPending

  return (
    <>
    <div
      className={
        view === 'grafo'
          ? 'app-shell is-graph-mode'
          : view === 'biblioteca'
            ? 'app-shell is-biblioteca-mode'
            : 'app-shell'
      }
    >
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
            className={navClass('criba')}
            onClick={() => {
              preferFreeZone.current = true
              setView('criba')
            }}
          >
            Criba
          </button>
          <button
            type="button"
            className={navClass('biblioteca')}
            onClick={() => {
              preferFreeZone.current = true
              setView('biblioteca')
            }}
          >
            Biblioteca
          </button>
          <button
            type="button"
            className={navClass('chats')}
            onClick={() => {
              preferFreeZone.current = true
              setView('chats')
            }}
          >
            Chats
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
            className={navClass('entidades')}
            onClick={() => setView('entidades')}
          >
            Entidades
            {entityPending > 0 && (
              <span className="nav-badge">{entityPending}</span>
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
          <button
            type="button"
            className={navClass('respaldo')}
            onClick={() => {
              preferFreeZone.current = true
              setView('respaldo')
            }}
          >
            Respaldo
          </button>
        </nav>
      </header>

      <main
        className={
          view === 'aduana' || view === 'criba'
            ? 'stage-aduana'
            : view === 'validada' ||
                view === 'quantomos' ||
                view === 'biblioteca' ||
                view === 'chats' ||
                view === 'respaldo'
              ? 'stage-validada'
              : view === 'entidades'
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
        ) : view === 'criba' ? (
          <CribaPanel refreshKey={refreshKey} onChanged={bump} />
        ) : view === 'biblioteca' ? (
          <BibliotecaSection refreshKey={refreshKey} onChanged={bump} />
        ) : view === 'chats' ? (
          <ChatsSection refreshKey={refreshKey} onChanged={bump} />
        ) : view === 'validada' ? (
          <ValidatedSection refreshKey={refreshKey} />
        ) : view === 'entidades' ? (
          <EntityHub
            refreshKey={refreshKey}
            onChanged={bump}
            personPending={personPending}
            projectPending={projectPending}
          />
        ) : view === 'quantomos' ? (
          <QuantomosSection refreshKey={refreshKey} />
        ) : view === 'grafo' ? (
          <GraphWorkspace refreshKey={refreshKey} onChanged={bump} />
        ) : view === 'respaldo' ? (
          <RespaldoSection refreshKey={refreshKey} />
        ) : (
          <FreeZone
            onProcessed={() => {
              preferFreeZone.current = false
              setView('aduana')
              bump()
            }}
            onChanged={bump}
          />
        )}
      </main>
    </div>
    <FeedbackWidget view={view} />
    </>
  )
}
