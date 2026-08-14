import { useCallback, useEffect, useState } from 'react'
import { api } from '../services/api'
import type { SandboxGraph } from '../types'
import { GraphSection } from './GraphSection'
import { SandboxGraphSection } from './SandboxGraphSection'

interface Props {
  refreshKey: number
  onChanged?: () => void
}

type BuiltinView = 'babel' | 'babel-3d'
type Selection = BuiltinView | string

function isBuiltin(sel: Selection): sel is BuiltinView {
  return sel === 'babel' || sel === 'babel-3d'
}

export function GraphWorkspace({ refreshKey, onChanged }: Props) {
  const [graphs, setGraphs] = useState<SandboxGraph[]>([])
  const [selection, setSelection] = useState<Selection>('babel')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    try {
      const res = await api.listSandboxGraphs()
      setGraphs(res.graphs)
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error al listar sandboxes'
      setError(
        msg.includes('404') || msg.includes('HTTP 404')
          ? 'API /sandboxes no disponible — reiniciá el server (npm run dev / server)'
          : msg,
      )
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList, refreshKey])

  const createGraph = async () => {
    const name = newName.trim() || `Sandbox ${graphs.length + 1}`
    setCreating(true)
    try {
      const { graph } = await api.createSandboxGraph({ name })
      setGraphs((prev) => [graph, ...prev])
      setSelection(graph.id)
      setNewName('')
      setError(null)
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear')
    } finally {
      setCreating(false)
    }
  }

  const deleteCurrent = async () => {
    if (isBuiltin(selection)) return
    if (!window.confirm('¿Borrar este sandbox y todo su contenido?')) return
    try {
      await api.deleteSandboxGraph(selection)
      setSelection('babel')
      await loadList()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo borrar')
    }
  }

  return (
    <div className="graph-workspace">
      <div className="graph-workspace-bar">
        <div className="graph-workspace-tabs">
          <button
            type="button"
            className={
              selection === 'babel' ? 'graph-hex-btn is-on' : 'graph-hex-btn'
            }
            onClick={() => setSelection('babel')}
            title="Universo CRM · vista 2D"
          >
            Babel
          </button>
          <button
            type="button"
            className={
              selection === 'babel-3d'
                ? 'graph-hex-btn is-on'
                : 'graph-hex-btn'
            }
            onClick={() => setSelection('babel-3d')}
            title="Mismo universo CRM · vista 3D"
          >
            Babel 3D
          </button>
          {graphs.map((g) => (
            <button
              key={g.id}
              type="button"
              className={
                selection === g.id ? 'graph-hex-btn is-on' : 'graph-hex-btn'
              }
              onClick={() => setSelection(g.id)}
              title={g.description || g.name}
            >
              {g.name}
            </button>
          ))}
        </div>
        <form
          className="graph-workspace-new"
          onSubmit={(e) => {
            e.preventDefault()
            void createGraph()
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nombre del sandbox…"
            className="graph-cmd"
          />
          <button
            type="submit"
            className="btn btn-tiny btn-primary"
            disabled={creating}
            title="Sandbox editable a mano (nodos libres + import CRM)"
          >
            + Nuevo
          </button>
          {!isBuiltin(selection) && (
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              onClick={() => void deleteCurrent()}
            >
              Borrar
            </button>
          )}
        </form>
      </div>
      {error && <p className="graph-toast-error mono">{error}</p>}
      {selection === 'babel' ? (
        <GraphSection
          key="babel-2d"
          refreshKey={refreshKey}
          onChanged={onChanged}
          mode="2d"
        />
      ) : selection === 'babel-3d' ? (
        <GraphSection
          key="babel-3d"
          refreshKey={refreshKey}
          onChanged={onChanged}
          mode="3d"
        />
      ) : (
        <SandboxGraphSection
          key={selection}
          graphId={selection}
          refreshKey={refreshKey}
          onChanged={() => {
            void loadList()
            onChanged?.()
          }}
        />
      )}
    </div>
  )
}
