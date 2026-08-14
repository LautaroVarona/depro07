import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import type {
  ChatBlock,
  ChatPreview,
  ChatSession,
  ChatTipo,
  Person,
} from '../types'

interface Props {
  refreshKey: number
  onChanged: () => void
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    // wall-clock ISO without Z
    return iso.replace('T', ' ').slice(0, 16)
  }
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ChatsSection({ refreshKey, onChanged }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [persons, setPersons] = useState<Person[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ChatPreview | null>(null)
  const [nombre, setNombre] = useState('')
  const [tipo, setTipo] = useState<ChatTipo>('individual')
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([])
  const [personQuery, setPersonQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<ChatBlock[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const data = await api.listChats()
      setSessions(data.sessions)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al listar chats')
    }
  }, [])

  const loadPersons = useCallback(async () => {
    try {
      const data = await api.listPersons()
      setPersons(data.persons ?? [])
    } catch {
      /* roster optional at boot */
    }
  }, [])

  useEffect(() => {
    void loadSessions()
    void loadPersons()
  }, [loadSessions, loadPersons, refreshKey])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await api.getChat(id)
      setSelectedId(id)
      setBlocks(data.blocks)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar chat')
    }
  }, [])

  async function onPick(files: FileList | null) {
    if (!files?.[0]) return
    const f = files[0]
    setFile(f)
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const data = await api.previewChat(f)
      setPreview(data.preview)
      setNombre(data.preview.suggested_name)
      setTipo(data.preview.tipo_auto)
      const matched: string[] = []
      for (const pName of data.preview.participantes) {
        const person = persons.find(
          (p) =>
            p.name.toLowerCase() === pName.toLowerCase() ||
            p.name.toLowerCase().includes(pName.toLowerCase()) ||
            pName.toLowerCase().includes(p.name.toLowerCase()),
        )
        if (person && !matched.includes(person.id)) matched.push(person.id)
      }
      setSelectedPersonIds(matched)
    } catch (err) {
      setPreview(null)
      setError(err instanceof Error ? err.message : 'Error en preview')
    } finally {
      setBusy(false)
    }
  }

  // Fix auto-match when persons load after preview
  useEffect(() => {
    if (!preview || persons.length === 0) return
    setSelectedPersonIds((prev) => {
      if (prev.length > 0) return prev
      const matched: string[] = []
      for (const pName of preview.participantes) {
        const person = persons.find(
          (p) =>
            p.name.toLowerCase() === pName.toLowerCase() ||
            p.name.toLowerCase().includes(pName.toLowerCase()) ||
            pName.toLowerCase().includes(p.name.toLowerCase()),
        )
        if (person && !matched.includes(person.id)) matched.push(person.id)
      }
      return matched
    })
  }, [preview, persons])

  const filteredPersons = useMemo(() => {
    const q = personQuery.trim().toLowerCase()
    const list = persons.filter((p) => p.source === 'manual' || !p.merged_into)
    if (!q) return list.slice(0, 40)
    return list
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 40)
  }, [persons, personQuery])

  function togglePerson(id: string) {
    setSelectedPersonIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  async function handleImport() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.importChat({
        file,
        nombre_chat: nombre.trim() || undefined,
        tipo,
        person_ids: selectedPersonIds,
      })
      setStatus(
        `Importado «${result.session.nombre_chat}»: ${result.message_count} msgs · ${result.block_count} bloques · ${result.link_count} links`,
      )
      setFile(null)
      setPreview(null)
      if (inputRef.current) inputRef.current.value = ''
      await loadSessions()
      await loadDetail(result.session.id)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al importar')
    } finally {
      setBusy(false)
    }
  }

  async function handleProcess(id: string, limit = 5) {
    setBusy(true)
    setError(null)
    try {
      const result = await api.processChat(id, limit)
      setStatus(
        `Procesados ${result.processed} bloques · quedan ${result.remaining}` +
          (result.errors.length
            ? ` · ${result.errors.length} error(es)`
            : ''),
      )
      await loadSessions()
      await loadDetail(id)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al procesar')
    } finally {
      setBusy(false)
    }
  }

  async function handleCreatePerson(name: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await api.createPerson({ name, kind: 'fisica' })
      await loadPersons()
      setSelectedPersonIds((prev) =>
        prev.includes(res.person.id) ? prev : [...prev, res.person.id],
      )
      setPersonQuery('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al crear persona')
    } finally {
      setBusy(false)
    }
  }

  const selected = sessions.find((s) => s.id === selectedId) ?? null

  return (
    <div className="entity-stage quantomos-stage">
      <section className="panel entity-panel">
        <div className="panel-head entity-head">
          <div>
            <h2>Chats</h2>
            <p className="muted mono">
              Importar exportaciones WhatsApp · desglose temporal · ENR
            </p>
          </div>
          <div className="entity-head-actions">
            <button
              type="button"
              className="btn btn-tiny"
              disabled={busy}
              onClick={() => void loadSessions()}
            >
              Recargar
            </button>
          </div>
        </div>

        <div className="profiles-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,text/plain"
            disabled={busy}
            onChange={(e) => void onPick(e.target.files)}
          />
        </div>

        {error && <p className="error-text">{error}</p>}
        {status && <p className="muted mono">{status}</p>}

        {preview && (
          <div className="panel" style={{ marginTop: 12, padding: 16 }}>
            <h3 style={{ marginTop: 0 }}>Introducción del chat</h3>
            <p className="muted">
              {preview.message_count} mensajes · {preview.link_count} links ·{' '}
              {formatTs(preview.first_ts)} → {formatTs(preview.last_ts)}
            </p>
            <label className="field">
              <span className="mono">Nombre</span>
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="field">
              <span className="mono">Tipo</span>
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value as ChatTipo)}
                disabled={busy}
              >
                <option value="individual">Individual</option>
                <option value="grupo">Grupo</option>
              </select>
              <span className="muted mono">
                auto: {preview.tipo_auto} ·{' '}
                {preview.participantes.join(', ') || 'sin remitentes'}
              </span>
            </label>

            <div style={{ marginTop: 12 }}>
              <p className="mono">Personas vinculadas (previo)</p>
              <input
                placeholder="Buscar o crear persona…"
                value={personQuery}
                onChange={(e) => setPersonQuery(e.target.value)}
                disabled={busy}
              />
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {filteredPersons.map((p) => {
                  const on = selectedPersonIds.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={
                        on ? 'filter-chip is-active' : 'filter-chip'
                      }
                      onClick={() => togglePerson(p.id)}
                      disabled={busy}
                    >
                      {p.name}
                    </button>
                  )
                })}
                {personQuery.trim() &&
                  !persons.some(
                    (p) =>
                      p.name.toLowerCase() === personQuery.trim().toLowerCase(),
                  ) && (
                    <button
                      type="button"
                      className="btn btn-tiny"
                      disabled={busy}
                      onClick={() =>
                        void handleCreatePerson(personQuery.trim())
                      }
                    >
                      Crear «{personQuery.trim()}»
                    </button>
                  )}
              </div>
            </div>

            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn"
                disabled={busy || !file}
                onClick={() => void handleImport()}
              >
                Importar chat
              </button>
            </div>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(220px, 1fr) minmax(280px, 2fr)',
            gap: 16,
            marginTop: 20,
          }}
        >
          <div>
            <h3>Sesiones</h3>
            {sessions.length === 0 ? (
              <p className="muted">Ningún chat importado aún.</p>
            ) : (
              <ul className="entity-list">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={
                        selectedId === s.id
                          ? 'entity-row is-selected'
                          : 'entity-row'
                      }
                      onClick={() => void loadDetail(s.id)}
                    >
                      <strong>{s.nombre_chat}</strong>
                      <span className="muted mono">
                        {s.tipo} · {s.status} · {s.block_count ?? 0} bloques ·{' '}
                        {s.pending_blocks ?? 0} pend.
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            {selected ? (
              <>
                <div className="panel-head entity-head">
                  <div>
                    <h3 style={{ margin: 0 }}>{selected.nombre_chat}</h3>
                    <p className="muted mono">
                      {selected.tipo} · {selected.status}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || (selected.pending_blocks ?? 0) === 0}
                    onClick={() => void handleProcess(selected.id, 2)}
                  >
                    Procesar 2 bloques
                  </button>
                </div>
                <p className="muted mono">
                  Desglose temporal (jornada / gap &gt; 4h)
                </p>
                <ul className="entity-list">
                  {blocks.map((b) => {
                    let summaryTitle = ''
                    try {
                      const s = JSON.parse(b.summary_json || '{}') as {
                        title?: string
                      }
                      summaryTitle = s.title || ''
                    } catch {
                      /* ignore */
                    }
                    return (
                      <li key={b.id} className="entity-row">
                        <strong>
                          {b.day_key} · {b.message_count} msgs · {b.estado}
                        </strong>
                        <span className="muted mono">
                          {formatTs(b.started_at)} → {formatTs(b.ended_at)}
                          {summaryTitle ? ` · ${summaryTitle}` : ''}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </>
            ) : (
              <p className="muted">Seleccioná una sesión para ver el desglose.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
