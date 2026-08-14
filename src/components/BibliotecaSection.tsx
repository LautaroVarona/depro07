import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import type {
  GraphicElement,
  Notebook,
  NotebookIndexEntry,
  NotebookPage,
  NotebookProcessLog,
  NotebookQueueStatus,
} from '../types'
import { PageValidationPanel } from './PageValidationPanel'
import { DigitalPageEditor } from './DigitalPageEditor'

type Mode = 'list' | 'reader' | 'validate' | 'digital'

const TOTAL_FACES = 160
const SPREAD_MAX = 81

function spreadIndexForSlot(slotIndex: number): number {
  if (slotIndex === 0) return 0
  if (slotIndex === 1) return 1
  if (slotIndex === TOTAL_FACES - 2) return 80
  if (slotIndex === TOTAL_FACES - 1) return SPREAD_MAX
  return 2 + Math.floor((slotIndex - 2) / 2)
}

function slotsForSpread(spreadIndex: number): number[] {
  if (spreadIndex === 0) return [0]
  if (spreadIndex === 1) return [1]
  if (spreadIndex === 80) return [TOTAL_FACES - 2]
  if (spreadIndex === SPREAD_MAX) return [TOTAL_FACES - 1]
  const left = 2 + (spreadIndex - 2) * 2
  return [left, left + 1]
}

function pageLabel(p: NotebookPage): string {
  const pos =
    p.posicion_visual === 'ImpactoTapa' ? 'Tapa' : p.posicion_visual
  if (pos === 'Tapa') return 'Tapa'
  if (pos === 'Contratapa') return 'Contratapa'
  if (pos === 'Suelta') return `Página ${p.numero_logico}`
  const side = pos === 'Izquierda' ? 'Izq' : 'Der'
  return `Página ${p.numero_logico} · ${side}`
}

function spreadLabel(spread: number): string {
  if (spread === 0) return 'Tapa'
  if (spread === 1) return 'Página 1'
  if (spread === 80) return 'Página 80'
  if (spread === SPREAD_MAX) return 'Contratapa'
  return `Apertura página ${spread}`
}

function statusClass(status: string): string {
  return `nb-status nb-status-${status.toLowerCase()}`
}

const EXPLANATION_SEPARATOR = '____________________'

function pageHasAiExplanation(p: NotebookPage): boolean {
  const user = (p.explanation_user || '').trim()
  const full = (p.explanation || '').trim()
  if (!full) return false
  if (full.includes(EXPLANATION_SEPARATOR)) return true
  if (user && full === user) return false
  return !user && full.length > 0
}

export function BibliotecaSection({
  refreshKey,
  onChanged,
}: {
  refreshKey: number
  onChanged: () => void
}) {
  const [mode, setMode] = useState<Mode>('list')
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pages, setPages] = useState<NotebookPage[]>([])
  const [index, setIndex] = useState<NotebookIndexEntry[]>([])
  const [summary, setSummary] = useState<{
    pendiente_validacion: number
    pendiente_vision: number
    validadas?: number
    procesadas: number
    with_image: number
  } | null>(null)
  const [visionQueue, setVisionQueue] = useState<NotebookQueueStatus>({
    running: false,
    pending: 0,
    confirm_running: false,
    confirm_pending: 0,
    current: null,
    logs: [],
  })
  const [spread, setSpread] = useState(0)
  const [validateSlot, setValidateSlot] = useState(0)
  const [newTitle, setNewTitle] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [indexQuery, setIndexQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [fullReading, setFullReading] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [sendingCorpus, setSendingCorpus] = useState(false)
  const [readModalOpen, setReadModalOpen] = useState(false)
  const [readModalMinimized, setReadModalMinimized] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(
    () => notebooks.find((n) => n.id === selectedId) ?? null,
    [notebooks, selectedId],
  )

  const loadList = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.listNotebooks()
      setNotebooks(res.notebooks)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al listar')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    const res = await api.getNotebook(id)
    setPages(res.pages)
    setIndex(res.index)
    setSummary(res.summary)
    setVisionQueue({
      running: res.vision_queue.running,
      pending: res.vision_queue.pending,
      confirm_running: res.vision_queue.confirm_running ?? false,
      confirm_pending: res.vision_queue.confirm_pending ?? 0,
      current: res.vision_queue.current ?? null,
      logs: res.vision_queue.logs ?? [],
      confirm_jobs: res.vision_queue.confirm_jobs,
    })
    setNotebooks((prev) => {
      const others = prev.filter((n) => n.id !== id)
      return [res.notebook, ...others]
    })
    return res
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList, refreshKey])

  useEffect(() => {
    if (!selectedId || mode === 'list') return
    const busy =
      visionQueue.running ||
      visionQueue.pending > 0 ||
      visionQueue.confirm_running ||
      visionQueue.confirm_pending > 0
    const id = window.setInterval(() => {
      void loadDetail(selectedId).catch(() => undefined)
    }, busy || readModalOpen ? 1500 : 4000)
    return () => window.clearInterval(id)
  }, [
    selectedId,
    mode,
    loadDetail,
    readModalOpen,
    visionQueue.running,
    visionQueue.pending,
    visionQueue.confirm_running,
    visionQueue.confirm_pending,
  ])

  const openNotebook = async (id: string) => {
    setSelectedId(id)
    setError(null)
    try {
      const res = await loadDetail(id)
      setMode(res.notebook.kind === 'digital' ? 'reader' : 'reader')
      const firstPending = res.pages.find(
        (p) =>
          p.status === 'PendienteValidacion' || p.status === 'Validada',
      )
      const firstWithImage = res.pages.find((p) => p.image_path)
      const slot = firstPending?.slot_index ?? firstWithImage?.slot_index ?? 0
      setSpread(spreadIndexForSlot(slot))
      setEditTitle(res.notebook.title)
      setIndexQuery('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al abrir')
    }
  }

  const createNotebook = async (kind: 'fisico' | 'digital') => {
    setCreating(true)
    setError(null)
    try {
      const title =
        newTitle.trim() ||
        (kind === 'digital' ? 'Cuaderno digital' : 'Cuaderno físico')
      const { notebook } = await api.createNotebook(title, kind)
      setNewTitle('')
      await loadList()
      onChanged()
      await openNotebook(notebook.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear')
    } finally {
      setCreating(false)
    }
  }

  const saveTitle = async () => {
    if (!selectedId) return
    const next = editTitle.trim()
    if (!next) {
      setEditTitle(selected?.title ?? '')
      return
    }
    if (next === selected?.title) return
    try {
      const { notebook } = await api.updateNotebook(selectedId, { title: next })
      setNotebooks((prev) => {
        const others = prev.filter((n) => n.id !== notebook.id)
        return [notebook, ...others]
      })
      setEditTitle(notebook.title)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo renombrar')
      setEditTitle(selected?.title ?? '')
    }
  }

  const onImport = async (filesInput: FileList | File[] | null) => {
    if (!selectedId || !filesInput) return
    const files = Array.isArray(filesInput)
      ? filesInput
      : Array.from(filesInput)
    if (files.length === 0) return
    const pdfs = files.filter(
      (f) =>
        f.type === 'application/pdf' ||
        f.name.toLowerCase().endsWith('.pdf'),
    )
    const images = files.filter((f) => !pdfs.includes(f))
    for (const pdf of pdfs) {
      await onPdf(pdf)
    }
    if (images.length > 0) {
      await onImages(images, { mode: 'append' })
    }
  }

  const startFullRead = async () => {
    if (!selectedId) return
    setFullReading(true)
    setError(null)
    setReadModalOpen(true)
    setReadModalMinimized(false)
    try {
      const res = await api.processNotebookOcr(selectedId)
      setVisionQueue({
        running: res.vision_queue.running,
        pending: res.vision_queue.pending,
        confirm_running: res.vision_queue.confirm_running,
        confirm_pending: res.vision_queue.confirm_pending,
        current: res.vision_queue.current ?? null,
        logs: res.vision_queue.logs ?? [],
        confirm_jobs: res.vision_queue.confirm_jobs,
      })
      await loadDetail(selectedId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar el cuaderno')
      setReadModalOpen(false)
    } finally {
      setFullReading(false)
    }
  }

  const startGenerateExplanations = async () => {
    if (!selectedId) return
    setExplaining(true)
    setError(null)
    setReadModalOpen(true)
    setReadModalMinimized(false)
    try {
      const res = await api.generateNotebookExplanations(selectedId)
      setVisionQueue({
        running: res.vision_queue.running,
        pending: res.vision_queue.pending,
        confirm_running: res.vision_queue.confirm_running,
        confirm_pending: res.vision_queue.confirm_pending,
        current: res.vision_queue.current ?? null,
        logs: res.vision_queue.logs ?? [],
        confirm_jobs: res.vision_queue.confirm_jobs,
      })
      await loadDetail(selectedId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al generar explicaciones')
    } finally {
      setExplaining(false)
    }
  }

  const startSendToCorpus = async () => {
    if (!selectedId) return
    setSendingCorpus(true)
    setError(null)
    setReadModalOpen(true)
    setReadModalMinimized(false)
    try {
      const res = await api.sendNotebookToCorpus(selectedId)
      setVisionQueue({
        running: res.vision_queue.running,
        pending: res.vision_queue.pending,
        confirm_running: res.vision_queue.confirm_running,
        confirm_pending: res.vision_queue.confirm_pending,
        current: res.vision_queue.current ?? null,
        logs: res.vision_queue.logs ?? [],
        confirm_jobs: res.vision_queue.confirm_jobs,
      })
      await loadDetail(selectedId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al enviar al corpus')
    } finally {
      setSendingCorpus(false)
    }
  }

  const openPageAnalysis = (slotIndex: number) => {
    setValidateSlot(slotIndex)
    setMode('validate')
  }

  const onPdf = async (file: File | null) => {
    if (!selectedId || !file) return
    setUploading(true)
    setError(null)
    try {
      const res = await api.ingestNotebookPdf(selectedId, file)
      if (res.warning) setError(res.warning)
      await loadDetail(selectedId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al importar PDF')
    } finally {
      setUploading(false)
    }
  }

  const onImages = async (
    filesInput: FileList | File[] | null,
    opts?: { mode?: 'append' | 'from_slot'; startSlot?: number },
  ) => {
    if (!selectedId || !filesInput) return
    const files = (
      Array.isArray(filesInput) ? filesInput : Array.from(filesInput)
    ).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    )
    if (files.length === 0) return
    setUploading(true)
    setError(null)
    try {
      const res = await api.ingestNotebookImages(selectedId, files, opts)
      const msg = [
        `${res.pages_imported} imagen(es) → slots ${res.slots_assigned.join(', ') || '—'}`,
        res.pending_ocr
          ? `${res.pending_ocr} listas para OCR (Procesar cuaderno)`
          : null,
        res.warning || null,
      ]
        .filter(Boolean)
        .join(' · ')
      if (msg) setError(msg)
      await loadDetail(selectedId)
      if (res.slots_assigned.length > 0) {
        setSpread(spreadIndexForSlot(res.slots_assigned[0]))
      }
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al importar imágenes')
    } finally {
      setUploading(false)
    }
  }

  const removeNotebook = async (id: string, title: string) => {
    const ok = window.confirm(
      `¿Borrar «${title}»?\nSe eliminan páginas, imágenes del vault y quantomos/entries asociados.`,
    )
    if (!ok) return
    setDeleting(true)
    setError(null)
    try {
      await api.deleteNotebook(id)
      if (selectedId === id) {
        setSelectedId(null)
        setMode('list')
        setPages([])
      }
      await loadList()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo borrar')
    } finally {
      setDeleting(false)
    }
  }

  const spreadSlots = slotsForSpread(spread)
  const spreadPages = spreadSlots
    .map((s) => pages.find((p) => p.slot_index === s))
    .filter(Boolean) as NotebookPage[]

  const indexEntries = useMemo(() => {
    const fromPages = pages.filter(
      (p) =>
        p.image_path ||
        (p.title && p.title.trim()) ||
        (p.transcription_spatial && p.transcription_spatial.trim()),
    )
    const q = indexQuery.trim().toLowerCase()
    const list = fromPages.length > 0 ? fromPages : pages.filter((p) =>
      index.some((e) => e.slot_index === p.slot_index),
    )
    if (!q) return list
    return list.filter((p) => {
      const hay = [
        p.title,
        pageLabel(p),
        p.posicion_visual,
        p.status,
        String(p.numero_logico),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [pages, index, indexQuery])

  const jobsBusy =
    fullReading ||
    explaining ||
    sendingCorpus ||
    visionQueue.running ||
    visionQueue.pending > 0 ||
    visionQueue.confirm_running ||
    visionQueue.confirm_pending > 0

  const currentReadSlot = visionQueue.current?.slot_index
  const currentReadPage =
    currentReadSlot != null
      ? pages.find((p) => p.slot_index === currentReadSlot) ?? null
      : null
  const readRemaining =
    visionQueue.pending +
    (visionQueue.current ? 1 : 0) +
    visionQueue.confirm_pending
  const pagesWithImage = pages.filter((p) => p.image_path).length
  const pagesRead = pages.filter(
    (p) =>
      p.image_path &&
      (p.status === 'PendienteValidacion' ||
        p.status === 'Validada' ||
        p.status === 'Procesada' ||
        p.status === 'Vacia'),
  ).length
  const pendingOcr = pages.filter((p) => p.status === 'PendienteVision').length
  const pendingVal = pages.filter(
    (p) => p.status === 'PendienteValidacion',
  ).length
  const validadas = pages.filter((p) => p.status === 'Validada').length
  const canGenerateExplanations =
    validadas > 0 && pendingOcr === 0 && pendingVal === 0
  const canSendToCorpus =
    canGenerateExplanations &&
    pages
      .filter((p) => p.status === 'Validada')
      .every((p) => pageHasAiExplanation(p))

  if (mode === 'validate' && selected) {
    return (
      <PageValidationPanel
        notebook={selected}
        slot={validateSlot}
        onSlotChange={setValidateSlot}
        onBack={() => {
          setMode('reader')
          void loadDetail(selected.id)
        }}
        onChanged={() => {
          onChanged()
          void loadDetail(selected.id)
        }}
      />
    )
  }

  if (mode === 'digital' && selected && selected.kind === 'digital') {
    return (
      <DigitalPageEditor
        notebook={selected}
        slot={validateSlot}
        onBack={() => {
          setMode('reader')
          void loadDetail(selected.id)
        }}
        onSaved={() => {
          onChanged()
          void loadDetail(selected.id)
        }}
      />
    )
  }

  if (mode === 'reader' && selected) {
    return (
      <section className="nb-section nb-reader-shell">
        <div className="nb-reader-bar">
          <button
            type="button"
            className="btn btn-ghost btn-tiny"
            onClick={() => {
              setMode('list')
              setSelectedId(null)
              void loadList()
            }}
          >
            ← Biblioteca
          </button>
          <div className="nb-reader-title">
            <input
              ref={titleInputRef}
              className="nb-title-edit"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={() => void saveTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
                if (e.key === 'Escape') {
                  setEditTitle(selected.title)
                  e.currentTarget.blur()
                }
              }}
              aria-label="Nombre del cuaderno"
            />
            <span className="nb-kind-hover">
              <span className="nb-kind-pill">
                {selected.kind === 'digital' ? 'Digital' : 'Físico'}
              </span>
              {summary && (
                <span className="nb-kind-stats">
                  Imágenes {summary.with_image} · Por validar{' '}
                  {summary.pendiente_validacion} · OCR {summary.pendiente_vision}{' '}
                  · Aprobadas {summary.validadas ?? 0} · Corpus{' '}
                  {summary.procesadas}
                </span>
              )}
            </span>
          </div>
          <div className="nb-reader-actions">
            <label className="btn btn-tiny">
              {uploading ? 'Importando…' : 'Importar'}
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,.pdf,.png,.jpg,.jpeg,.webp"
                multiple
                hidden
                disabled={uploading}
                onChange={(e) => {
                  void onImport(e.target.files)
                  e.target.value = ''
                }}
              />
            </label>
            <button
              type="button"
              className="btn btn-tiny btn-primary"
              disabled={fullReading || uploading}
              onClick={() => void startFullRead()}
            >
              {visionQueue.running || visionQueue.pending > 0
                ? `OCR ${visionQueue.pending}`
                : fullReading
                  ? 'Encolando…'
                  : 'Procesar cuaderno'}
            </button>
            {canGenerateExplanations && (
              <button
                type="button"
                className="btn btn-tiny"
                disabled={explaining || jobsBusy}
                onClick={() => void startGenerateExplanations()}
              >
                {explaining || visionQueue.current?.phase === 'explain'
                  ? 'Explicando…'
                  : 'Generar explicaciones'}
              </button>
            )}
            {canSendToCorpus && (
              <button
                type="button"
                className="btn btn-tiny btn-primary"
                disabled={sendingCorpus || jobsBusy}
                onClick={() => void startSendToCorpus()}
              >
                {sendingCorpus || visionQueue.current?.phase === 'confirm'
                  ? 'Enviando…'
                  : 'Enviar al corpus'}
              </button>
            )}
          </div>
        </div>

        {error && <p className="nb-error">{error}</p>}

        <div className="nb-reader-layout">
          <aside className="nb-index-rail">
            <h3>Índice</h3>
            <input
              className="nb-input nb-index-search"
              placeholder="Buscar en el índice"
              value={indexQuery}
              onChange={(e) => setIndexQuery(e.target.value)}
            />
            <ul className="nb-index-list">
              {indexEntries.map((p) => {
                const active = spreadSlots.includes(p.slot_index)
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={`nb-index-item${active ? ' is-active' : ''}`}
                      onClick={() => setSpread(spreadIndexForSlot(p.slot_index))}
                    >
                      <span className="nb-index-item-title">
                        {p.title || pageLabel(p)}
                      </span>
                      <span className="muted">
                        {pageLabel(p)}
                        {p.status !== 'Vacia' ? ` · ${p.status}` : ''}
                      </span>
                    </button>
                  </li>
                )
              })}
              {indexEntries.length === 0 && (
                <li className="muted nb-index-empty">Sin entradas</li>
              )}
            </ul>
          </aside>

          <div className="nb-reader-stage">
            <div className="nb-spread-nav">
              <button
                type="button"
                className="btn btn-tiny"
                disabled={spread <= 0}
                onClick={() => setSpread((s) => Math.max(0, s - 1))}
              >
                ← Anterior
              </button>
              <span>
                {spreadLabel(spread)}
                <span className="muted">
                  {' '}
                  ({spread + 1}/{SPREAD_MAX + 1})
                </span>
              </span>
              <button
                type="button"
                className="btn btn-tiny"
                disabled={spread >= SPREAD_MAX}
                onClick={() => setSpread((s) => Math.min(SPREAD_MAX, s + 1))}
              >
                Siguiente →
              </button>
            </div>
            <p className="muted nb-spread-hint">
              Clic en una hoja abre la transcripción. Aprobá cada página; cuando
              el cuaderno esté validado, generá explicaciones y mandalo al corpus.
            </p>

            <div
              className={
                spreadPages.length > 1
                  ? 'nb-spread is-double'
                  : 'nb-spread is-single'
              }
            >
              {spreadPages.map((p) => (
                <article key={p.id} className="nb-face">
                  <header className="nb-face-head">
                    <span>{pageLabel(p)}</span>
                    <span className={statusClass(p.status)}>{p.status}</span>
                  </header>
                  <button
                    type="button"
                    className="nb-face-body is-open"
                    onClick={() => openPageAnalysis(p.slot_index)}
                  >
                    {p.image_path ? (
                      <img
                        src={api.notebookPageImageUrl(
                          selected.id,
                          p.slot_index,
                        )}
                        alt={pageLabel(p)}
                      />
                    ) : (
                      <div className="nb-face-empty">Sin imagen</div>
                    )}
                  </button>
                  <footer className="nb-face-foot">
                    <button
                      type="button"
                      className="nb-face-title is-link"
                      onClick={() => openPageAnalysis(p.slot_index)}
                    >
                      {p.title || (p.is_blank ? '(vacía)' : '—')}
                    </button>
                    <div className="nb-face-actions">
                      <button
                        type="button"
                        className="btn btn-tiny btn-primary"
                        onClick={() => openPageAnalysis(p.slot_index)}
                      >
                        Transcripción
                      </button>
                      {selected.kind === 'digital' && (
                        <button
                          type="button"
                          className="btn btn-tiny"
                          onClick={() => {
                            setValidateSlot(p.slot_index)
                            setMode('digital')
                          }}
                        >
                          Lienzo
                        </button>
                      )}
                    </div>
                  </footer>
                  {p.transcription_spatial?.trim() ? (
                    <p className="nb-face-tx">{p.transcription_spatial}</p>
                  ) : p.status === 'PendienteVision' ? (
                    <p className="nb-face-tx is-wait">Pendiente de OCR</p>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        </div>

        {readModalOpen && !readModalMinimized && (
          <div
            className="nb-read-scrim"
            role="dialog"
            aria-modal="true"
            aria-labelledby="nb-read-title"
          >
            <div
              className="nb-read-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="nb-read-modal-head">
                <h3 id="nb-read-title">
                  {jobsBusy
                    ? visionQueue.current?.phase === 'confirm'
                      ? 'Enviando al corpus…'
                      : visionQueue.current?.phase === 'explain'
                        ? 'Explicando página…'
                        : 'Transcribiendo página…'
                    : visionQueue.current?.phase === 'explain'
                      ? 'Explicaciones'
                      : visionQueue.current?.phase === 'confirm'
                        ? 'Corpus'
                        : 'Procesar cuaderno'}
                </h3>
                <button
                  type="button"
                  className="btn btn-tiny btn-ghost"
                  onClick={() => setReadModalMinimized(true)}
                >
                  Ocultar
                </button>
              </header>
              <p className="nb-read-progress">
                {jobsBusy
                  ? `Página ${
                      currentReadSlot != null ? currentReadSlot + 1 : '—'
                    } · quedan ${readRemaining} · ${pagesRead}/${pagesWithImage || '—'} con resultado`
                  : `Listo · ${pagesRead} hojas con lectura`}
              </p>
              <div className="nb-read-preview">
                {currentReadPage?.image_path && selected ? (
                  <img
                    src={api.notebookPageImageUrl(
                      selected.id,
                      currentReadPage.slot_index,
                    )}
                    alt={pageLabel(currentReadPage)}
                  />
                ) : (
                  <div className="nb-face-empty">
                    {jobsBusy ? 'Preparando…' : 'Sin página en curso'}
                  </div>
                )}
              </div>
              {currentReadPage && (
                <p className="muted nb-read-caption">
                  {pageLabel(currentReadPage)}
                  {currentReadPage.title
                    ? ` · ${currentReadPage.title}`
                    : ''}
                </p>
              )}
              <ul className="nb-read-logs">
                {(visionQueue.logs ?? []).slice(-8).map((log: NotebookProcessLog, i) => (
                  <li
                    key={`${log.ts}-${i}`}
                    className={`nb-read-log nb-read-log-${log.level}`}
                  >
                    {log.slot_index != null ? `p${log.slot_index + 1} · ` : ''}
                    {log.message}
                  </li>
                ))}
                {(visionQueue.logs ?? []).length === 0 && (
                  <li className="muted">Encolando hojas…</li>
                )}
              </ul>
              {!jobsBusy && (
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  onClick={() => setReadModalOpen(false)}
                >
                  Cerrar
                </button>
              )}
            </div>
          </div>
        )}

        {readModalOpen && readModalMinimized && jobsBusy && (
          <button
            type="button"
            className="nb-read-chip"
            onClick={() => setReadModalMinimized(false)}
          >
            Leyendo {readRemaining}…
          </button>
        )}
      </section>
    )
  }

  return (
    <section className="nb-section">
      <header className="nb-library-head">
        <div>
          <h2>Biblioteca</h2>
          <p className="muted">
            Cuadernos físicos (PDF) y digitales · 80 hojas / 160 caras
          </p>
        </div>
        <div className="nb-create-row">
          <input
            className="nb-input"
            placeholder="Nombre del cuaderno"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={creating}
            onClick={() => void createNotebook('fisico')}
          >
            + Físico
          </button>
          <button
            type="button"
            className="btn btn-tiny"
            disabled={creating}
            onClick={() => void createNotebook('digital')}
          >
            + Digital
          </button>
        </div>
      </header>

      {error && <p className="nb-error">{error}</p>}
      {loading && <p className="muted">Cargando…</p>}

      <div className="nb-grid">
        {notebooks.map((n) => (
          <div key={n.id} className="nb-card">
            <button
              type="button"
              className="nb-card-main"
              onClick={() => void openNotebook(n.id)}
            >
              <div className="nb-card-cover">
                {n.cover_url ? (
                  <img
                    src={
                      n.cover_url.startsWith('vault/')
                        ? api.notebookPageImageUrl(
                            n.id,
                            Number(
                              n.cover_url
                                .split('/')
                                .pop()
                                ?.replace('.png', '') || 0,
                            ),
                          )
                        : n.cover_url
                    }
                    alt=""
                  />
                ) : (
                  <div className="nb-card-cover-empty">{n.kind}</div>
                )}
              </div>
              <div className="nb-card-meta">
                <strong>{n.title}</strong>
                <span className="muted">
                  {n.kind} · índice {n.index_status}
                </span>
              </div>
            </button>
            <button
              type="button"
              className="btn btn-tiny btn-ghost danger-text nb-card-delete"
              disabled={deleting}
              onClick={(e) => {
                e.stopPropagation()
                void removeNotebook(n.id, n.title)
              }}
            >
              Borrar
            </button>
          </div>
        ))}
        {!loading && notebooks.length === 0 && (
          <p className="muted">Todavía no hay cuadernos. Creá uno arriba.</p>
        )}
      </div>
    </section>
  )
}

/** Re-export for type consumers if needed */
export type { GraphicElement }
