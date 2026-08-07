import { useCallback, useEffect, useState } from 'react'
import { api, type ProposalBundle } from '../services/api'

interface Props {
  refreshKey: number
}

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

function buildValidatedExport(entries: ProposalBundle[]) {
  return {
    exported_at: new Date().toISOString(),
    source: 'deprocast-validada',
    count: entries.length,
    entries: entries.map((entry) => {
      const meta = entry.file_metadata
      return {
        id: entry.id,
        title: entry.title,
        source_type: entry.source_type,
        status: entry.status,
        timestamp_exact: entry.timestamp_exact,
        created_at: entry.created_at,
        transcription: meta?.transcription ?? entry.content_raw,
        file_metadata: meta
          ? {
              assigned_title: meta.assigned_title,
              timestamp_exact: meta.timestamp_exact,
              original_filename: meta.original_filename,
              transcription: meta.transcription,
              stored_at: meta.stored_at,
            }
          : null,
        quantomos: entry.quantomos.map((q) => ({
          id: q.id,
          title: q.title,
          content: q.content,
          hermetic_weight: q.hermetic_weight,
          universe: q.universe,
        })),
        tasks: entry.tasks
          .filter((t) => t.status === 'accepted' || t.status === 'suggested')
          .map((t) => ({
            id: t.id,
            task_text: t.task_text,
            tag: t.tag,
            status: t.status,
          })),
      }
    }),
  }
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ValidatedSection({ refreshKey }: Props) {
  const [entries, setEntries] = useState<ProposalBundle[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.getValidated()
      setEntries(data.entries)
      setExpandedId((prev) =>
        prev && data.entries.some((e) => e.id === prev) ? prev : null,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar Validada')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    const id = window.setInterval(() => void load(), 8000)
    return () => window.clearInterval(id)
  }, [load])

  async function handleDelete(entryId: string, title: string) {
    const ok = window.confirm(`¿Borrar «${title}» de Validada?`)
    if (!ok) return

    setBusyId(entryId)
    setError(null)
    try {
      await api.deleteEntry(entryId)
      if (expandedId === entryId) setExpandedId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al borrar')
    } finally {
      setBusyId(null)
    }
  }

  function handleExportAll() {
    if (entries.length === 0) return
    const payload = buildValidatedExport(entries)
    const day = new Date().toISOString().slice(0, 10)
    downloadJson(`deprocast-validada-${day}.json`, payload)
  }

  return (
    <section className="panel validated-section" id="validada">
      <header className="panel-head validated-head">
        <h2>Validada</h2>
        <div className="validated-head-actions">
          <span className="muted mono validated-count">
            {entries.length} {entries.length === 1 ? 'nota' : 'notas'}
          </span>
          <button
            type="button"
            className="btn btn-tiny"
            disabled={entries.length === 0}
            onClick={handleExportAll}
          >
            Exportar todo
          </button>
        </div>
      </header>

      {error && <p className="status-line err">{error}</p>}
      {loading && entries.length === 0 && (
        <p className="muted empty">Cargando…</p>
      )}
      {!loading && entries.length === 0 && (
        <p className="muted empty">Todavía no hay notas validadas.</p>
      )}

      <div className="validated-grid">
        {entries.map((entry) => {
          const open = expandedId === entry.id
          const acceptedTasks = entry.tasks.filter(
            (t) => t.status === 'accepted' || t.status === 'suggested',
          )
          return (
            <article
              key={entry.id}
              className={open ? 'validated-card is-open' : 'validated-card'}
            >
              <div className="validated-card-header">
                <button
                  type="button"
                  className="validated-card-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setExpandedId((id) => (id === entry.id ? null : entry.id))
                  }
                >
                  <div className="validated-card-main">
                    <h3 className="validated-card-title">{entry.title}</h3>
                    <p className="validated-card-meta mono">
                      {formatTs(entry.timestamp_exact)}
                      {entry.source_type === 'audio' ? ' · audio' : ''}
                    </p>
                  </div>
                  <span className="validated-chevron" aria-hidden>
                    {open ? '▾' : '▸'}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn btn-tiny danger-text validated-delete"
                  disabled={busyId === entry.id}
                  onClick={() => void handleDelete(entry.id, entry.title)}
                >
                  Borrar
                </button>
              </div>

              {open && (
                <div className="validated-card-body">
                  {entry.file_metadata && (
                    <div className="block">
                      <h4>Metadata del archivo</h4>
                      <dl className="validated-meta-dl">
                        <div>
                          <dt>Nombre asignado</dt>
                          <dd>{entry.file_metadata.assigned_title}</dd>
                        </div>
                        <div>
                          <dt>Fecha</dt>
                          <dd className="mono">
                            {formatTs(entry.file_metadata.timestamp_exact)}
                          </dd>
                        </div>
                        <div>
                          <dt>Nombre original</dt>
                          <dd className="mono">
                            {entry.file_metadata.original_filename || '—'}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  )}

                  <div className="validated-body-grid">
                    <div className="block">
                      <h4>Quántomos</h4>
                      {entry.quantomos.length === 0 ? (
                        <p className="muted">Ninguno</p>
                      ) : (
                        <ul className="validated-list">
                          {entry.quantomos.map((q) => (
                            <li key={q.id}>
                              <strong>{q.title}</strong>
                              <p>{q.content}</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="block">
                      <h4>Tareas</h4>
                      {acceptedTasks.length === 0 ? (
                        <p className="muted">Ninguna</p>
                      ) : (
                        <ul className="validated-list">
                          {acceptedTasks.map((t) => (
                            <li key={t.id} className="validated-task">
                              {t.tag && <span className="tag">{t.tag}</span>}
                              <span>{t.task_text}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>

                  {(entry.file_metadata?.transcription ||
                    entry.content_raw) && (
                    <div className="block">
                      <h4>Transcripción literal</h4>
                      <pre className="transcript transcript-validated">
                        {entry.file_metadata?.transcription ||
                          entry.content_raw ||
                          '—'}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
