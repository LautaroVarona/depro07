import { useCallback, useEffect, useState } from 'react'
import { api } from '../services/api'

interface Props {
  refreshKey: number
}

type Summary = Awaited<ReturnType<typeof api.backupSummary>>

export function RespaldoSection({ refreshKey }: Props) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [confirm, setConfirm] = useState('')
  const [restoring, setRestoring] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.backupSummary()
      setSummary(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al leer el resumen')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  function download(format: 'json' | 'csv' | 'xml') {
    window.location.href = `/api/backup?format=${format}`
  }

  async function handleRestore() {
    if (!file) return
    if (confirm !== 'REEMPLAZAR') return
    setRestoring(true)
    setError(null)
    setStatus(null)
    try {
      await api.restoreBackup(file)
      setStatus('Respaldo restaurado. Recargando…')
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore fallido')
      setRestoring(false)
    }
  }

  const g = summary?.groups
  const canRestore = Boolean(file) && confirm === 'REEMPLAZAR' && !restoring

  return (
    <section className="panel respaldo-section" id="respaldo">
      <header className="panel-head">
        <h2>Respaldo</h2>
        {summary && (
          <span className="muted mono">{summary.exported_at.slice(0, 19)}</span>
        )}
      </header>

      <p className="muted respaldo-warn">
        Exporta toda la actividad estructurada (transcripciones, perfiles,
        conexiones, quántomos, validaciones y el resto de tablas). No incluye
        audios, videos ni imágenes de la carpeta vault. Al importar se borra
        por completo el estado local y se deja exactamente el archivo.
      </p>

      {error && <p className="status-line err">{error}</p>}
      {status && <p className="status-line ok">{status}</p>}
      {loading && !summary && <p className="muted empty">Cargando…</p>}

      {g && (
        <div className="respaldo-counts">
          <div>
            <strong>{g.transcripciones}</strong>
            <span>Transcripciones</span>
          </div>
          <div>
            <strong>{g.perfiles}</strong>
            <span>Perfiles</span>
          </div>
          <div>
            <strong>{g.conexiones}</strong>
            <span>Conexiones</span>
          </div>
          <div>
            <strong>{g.quantomos}</strong>
            <span>Quántomos</span>
          </div>
          <div>
            <strong>{g.validaciones}</strong>
            <span>Validaciones</span>
          </div>
          <div>
            <strong>{g.resto}</strong>
            <span>Resto</span>
          </div>
        </div>
      )}

      <div className="respaldo-block">
        <h3>Exportar</h3>
        <p className="muted">
          JSON es el único formato que se puede volver a importar. CSV y XML
          son para lectura o planillas.
        </p>
        <div className="respaldo-actions">
          <button type="button" className="btn btn-primary" onClick={() => download('json')}>
            JSON
          </button>
          <button type="button" className="btn" onClick={() => download('csv')}>
            CSV
          </button>
          <button type="button" className="btn" onClick={() => download('xml')}>
            XML
          </button>
        </div>
      </div>

      <div className="respaldo-block respaldo-danger">
        <h3>Importar (reemplaza todo)</h3>
        <p className="muted">
          Solo JSON de Deprocast. Escribí REEMPLAZAR para confirmar. Esta
          acción no se puede deshacer.
        </p>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {file && <p className="mono muted">{file.name}</p>}
        <input
          className="respaldo-confirm"
          type="text"
          placeholder="Escribí REEMPLAZAR"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn btn-ghost danger"
          disabled={!canRestore}
          onClick={() => void handleRestore()}
        >
          {restoring ? 'Restaurando…' : 'Restaurar respaldo'}
        </button>
      </div>
    </section>
  )
}
