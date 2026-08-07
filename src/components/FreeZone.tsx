import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Entry } from '../services/api'

const AUDIO_EXTS = [
  '.m4a',
  '.mp3',
  '.ogg',
  '.oga',
  '.opus',
  '.aac',
  '.wav',
  '.mp4',
] as const

function isAcceptedAudio(file: File): boolean {
  const name = file.name.toLowerCase()
  if (AUDIO_EXTS.some((ext) => name.endsWith(ext))) return true
  const mime = (file.type || '').toLowerCase()
  if (!mime) return false
  // Voice Memos / WhatsApp a veces marcan .m4a como video/mp4
  if (mime === 'video/mp4' && name.endsWith('.m4a')) return true
  if (mime.startsWith('audio/')) return true
  if (mime === 'application/ogg') return true
  return false
}

interface Props {
  onProcessed: () => void
}

export function FreeZone({ onProcessed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<File[]>([])
  const [queued, setQueued] = useState<Entry[]>([])
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshQueued = useCallback(async () => {
    try {
      const [data, pipe] = await Promise.all([
        api.getQueued(),
        api.getPipelineStatus(),
      ])
      setQueued(data.entries)
      setPaused(pipe.paused)
      setRunning(pipe.running)
    } catch (err) {
      console.error(err)
    }
  }, [])

  useEffect(() => {
    void refreshQueued()
    const id = window.setInterval(() => void refreshQueued(), 4000)
    return () => window.clearInterval(id)
  }, [refreshQueued])

  function onPick(files: FileList | null) {
    if (!files) return
    const all = Array.from(files)
    const list = all.filter(isAcceptedAudio)
    const rejected = all.length - list.length
    setSelected((prev) => {
      const names = new Set(prev.map((p) => `${p.name}:${p.size}`))
      const next = [...prev]
      for (const f of list) {
        const key = `${f.name}:${f.size}`
        if (!names.has(key)) next.push(f)
      }
      return next
    })
    setError(
      rejected > 0
        ? `${rejected} archivo(s) ignorado(s). Usá .m4a, .mp3, .ogg, .opus, .aac o .wav`
        : null,
    )
  }

  function removeFile(name: string, size: number) {
    setSelected((prev) =>
      prev.filter((f) => !(f.name === name && f.size === size)),
    )
  }

  async function handleProcess() {
    if (selected.length === 0 && queued.length === 0) {
      setError('Seleccioná al menos un audio (.m4a, .mp3, .ogg…)')
      return
    }

    setBusy(true)
    setError(null)
    setStatus(null)

    try {
      if (selected.length > 0) {
        const files = [...selected]
        let uploaded = 0
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!
          const mb = (f.size / (1024 * 1024)).toFixed(1)
          setStatus(`Subiendo ${i + 1}/${files.length}: ${f.name} (${mb} MB)`)
          console.log(`[freezone] upload ${i + 1}/${files.length}`, f.name, mb)
          const result = await api.ingestAudioOne(f)
          uploaded += result.entries.length
          // quitar de la selección a medida que sube
          setSelected((prev) =>
            prev.filter((x) => !(x.name === f.name && x.size === f.size)),
          )
          await refreshQueued()
        }
        setStatus(`Subidos ${uploaded} audio(s). Encolando pipeline…`)
        if (inputRef.current) inputRef.current.value = ''
      }

      const pipeline = await api.runPipeline()
      setPaused(false)
      setStatus(
        pipeline.message ||
          'Pipeline en marcha — la aduana aparece al terminar.',
      )
      await refreshQueued()
      onProcessed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al procesar')
    } finally {
      setBusy(false)
    }
  }

  async function handlePause() {
    setError(null)
    try {
      const result = await api.pausePipeline()
      setPaused(true)
      setStatus(result.message)
      await refreshQueued()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al pausar')
    }
  }

  async function handleResume() {
    setError(null)
    try {
      const result = await api.resumePipeline()
      setPaused(false)
      setStatus(result.message)
      await refreshQueued()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al reanudar')
    }
  }

  async function handleDeleteEntry(entryId: string) {
    setError(null)
    try {
      await api.deleteEntry(entryId)
      setStatus('Carga eliminada')
      await refreshQueued()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar')
    }
  }

  async function handleClearActive() {
    if (queued.length === 0) return
    if (
      !window.confirm(
        `¿Eliminar ${queued.length} carga(s) activa(s)? Esto borra los audios del vault.`,
      )
    ) {
      return
    }
    setError(null)
    try {
      await api.pausePipeline()
      const result = await api.clearQueuedEntries()
      setPaused(true)
      setStatus(`Eliminadas ${result.deleted} carga(s) activa(s)`)
      setSelected([])
      if (inputRef.current) inputRef.current.value = ''
      await refreshQueued()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al vaciar cola')
    }
  }

  const canProcess = !busy && (selected.length > 0 || queued.length > 0)
  const hasActive = queued.length > 0 || running

  return (
    <section className="panel freezone">
      <header className="panel-head">
        <h2>Zona franca</h2>
        {(paused || running) && (
          <p className="muted mono pipeline-state">
            {paused ? 'pausado' : running ? 'procesando' : ''}
          </p>
        )}
      </header>

      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          onPick(e.dataTransfer.files)
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".m4a,.mp3,.ogg,.oga,.opus,.aac,.wav,.mp4,audio/*,audio/mp4,audio/x-m4a,audio/mpeg,audio/ogg,audio/opus,audio/aac,audio/wav,application/ogg"
          multiple
          className="file-input"
          onChange={(e) => onPick(e.target.files)}
        />
        <p className="dropzone-label">
          Arrastrá o elegí archivos
          <span className="dropzone-exts">
            .m4a · .mp3 · .ogg · .opus · .aac · .wav
          </span>
        </p>
      </div>

      {selected.length > 0 && (
        <ul className="file-list">
          {selected.map((f) => (
            <li key={`${f.name}-${f.size}`}>
              <span className="mono truncate">{f.name}</span>
              <span className="file-meta">
                <span className="muted">{(f.size / 1024).toFixed(0)} KB</span>
                <button
                  type="button"
                  className="btn btn-tiny"
                  onClick={() => removeFile(f.name, f.size)}
                >
                  Quitar
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="actions-row">
        {hasActive && !paused && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void handlePause()}
          >
            Pausar
          </button>
        )}
        {paused && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => void handleResume()}
          >
            Reanudar
          </button>
        )}
        {queued.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost danger"
            disabled={busy}
            onClick={() => void handleClearActive()}
          >
            Eliminar cargas
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canProcess}
          onClick={() => void handleProcess()}
        >
          {busy ? 'Subiendo / procesando…' : paused ? 'Procesar (reanuda)' : 'Procesar'}
        </button>
      </div>

      {status && <p className="status-line ok">{status}</p>}
      {error && <p className="status-line err">{error}</p>}

      {queued.length > 0 && (
        <div className="queue-block">
          <div className="queue-head">
            <h3>En cola</h3>
            <button
              type="button"
              className="btn btn-tiny"
              onClick={() => void refreshQueued()}
            >
              Refresh
            </button>
          </div>
          <ul className="queue-list">
            {queued.map((e) => (
              <li key={e.id}>
                <span className={`badge badge-${e.status}`}>{e.status}</span>
                <span className="mono truncate">{e.title}</span>
                <button
                  type="button"
                  className="btn btn-tiny danger-text"
                  onClick={() => void handleDeleteEntry(e.id)}
                  title="Eliminar esta carga"
                >
                  Eliminar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
