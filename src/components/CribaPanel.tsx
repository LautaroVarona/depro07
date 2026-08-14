import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../services/api'
import type {
  Bookmark,
  BookmarkCounts,
  BookmarkProcessedRow,
  BookmarkQueueStatus,
  BookmarkSource,
} from '../types'
import { downloadJson } from '../utils/downloadJson'
import { CribaNotePanel } from './CribaNotePanel'

type Props = {
  refreshKey: number
  onChanged?: () => void
}

type SortOrder = 'asc' | 'desc' | 'random'
type SourceFilter = 'all' | BookmarkSource
type StageTab = 'pendientes' | 'validados' | 'procesados'
type ApprovalFilter = 'pending' | 'approved'

const EMPTY_COUNTS: BookmarkCounts = {
  total: 0,
  pendientes: 0,
  cribados: 0,
  procesados: 0,
  validados: 0,
  high_value_ready: 0,
  awaiting_approval: 0,
  sin_aprobar: 0,
  aprobados: 0,
  slop: 0,
}

const EMPTY_QUEUE: BookmarkQueueStatus = {
  running: false,
  stop_requested: false,
  target: 0,
  done: 0,
  remaining: 0,
  skipped: 0,
  current_id: null,
  current_title: null,
  last_item: null,
  errors: [],
  started_at: null,
  finished_at: null,
}

function keyToWeight(e: KeyboardEvent): number | null {
  const k = e.key
  if (k >= '1' && k <= '9') return Number(k)
  if (k === '0' || k === 'q' || k === 'Q') return 10
  if (k === "'" || k === '.' || k === 'w' || k === 'W') return 11
  if (k === '¡' || k === 'Enter' || k === 'e' || k === 'E') return 12
  return null
}

function parseMediaUrls(raw: string | null | undefined): string[] {
  if (!raw) return []
  const t = raw.trim()
  if (!t || t === '[]') return []

  let candidates: string[] = []
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown
      if (Array.isArray(parsed)) candidates = parsed.map(String)
    } catch {
      /* fallthrough */
    }
  } else if (t.includes(',')) {
    candidates = t.split(',')
  } else {
    candidates = [t]
  }

  return candidates
    .map((u) => u.trim().replace(/^["']|["']$/g, ''))
    .filter((u) => /^https?:\/\//i.test(u))
}

function formatBookmarkDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function oneLine(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

function Dropzone({
  busy,
  onFiles,
}: {
  busy: boolean
  onFiles: (files: FileList | File[]) => void
}) {
  return (
    <div
      className="dropzone criba-dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void onFiles(e.dataTransfer.files)
      }}
    >
      <input
        className="file-input"
        type="file"
        accept=".csv,.json,text/csv,application/json"
        disabled={busy}
        onChange={(e) => {
          if (e.target.files) void onFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <p className="dropzone-label">
        Arrastrá Twitter (CSV/JSON) o Instagram (ig_export.json)
        <span className="dropzone-exts">
          X: id, text, author… · IG: url_video, descripcion_reel, shortcode…
        </span>
      </p>
    </div>
  )
}

export function CribaPanel({ refreshKey, onChanged }: Props) {
  const [stage, setStage] = useState<StageTab>('pendientes')
  const [approvalFilter, setApprovalFilter] =
    useState<ApprovalFilter>('pending')
  const [queue, setQueue] = useState<Bookmark[]>([])
  const [counts, setCounts] = useState<BookmarkCounts>(EMPTY_COUNTS)
  const [validados, setValidados] = useState<Bookmark[]>([])
  const [procesados, setProcesados] = useState<BookmarkProcessedRow[]>([])
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [shuffleNonce, setShuffleNonce] = useState(0)
  const [weightMin, setWeightMin] = useState(1)
  const [weightMax, setWeightMax] = useState(12)
  const [busy, setBusy] = useState(false)
  const [queueStatus, setQueueStatus] =
    useState<BookmarkQueueStatus>(EMPTY_QUEUE)
  const [error, setError] = useState<string | null>(null)
  const [sliderWeight, setSliderWeight] = useState(6)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [mediaBusy, setMediaBusy] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [importHint, setImportHint] = useState<string | null>(null)
  const [ocrBusyId, setOcrBusyId] = useState<string | null>(null)
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null)
  const [ocrPending, setOcrPending] = useState(0)
  const assigning = useRef(false)
  const currentId = queue[0]?.id

  const loadPending = useCallback(
    async (opts?: { soft?: boolean; order?: SortOrder }) => {
      const order = opts?.order ?? sortOrder
      try {
        const data = await api.getPendingBookmarks(20, order, sourceFilter)
        setCounts(data.counts)
        setQueue((prev) => {
          if (opts?.soft && prev.length > 3) {
            const ids = new Set(prev.map((b) => b.id))
            const extra = data.pending.filter((b) => !ids.has(b.id))
            return [...prev, ...extra].slice(0, 40)
          }
          return data.pending
        })
        setError(null)
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Error cargando pendientes',
        )
      }
    },
    [sortOrder, sourceFilter],
  )

  const loadValidados = useCallback(async () => {
    try {
      const data = await api.getScoredBookmarks(2000, {
        minWeight: weightMin,
        maxWeight: weightMax,
        source: sourceFilter,
        status: 'cribado',
      })
      setValidados(data.scored)
      setCounts(data.counts)
    } catch {
      /* silent */
    }
  }, [weightMin, weightMax, sourceFilter])

  const loadProcesados = useCallback(async () => {
    try {
      const data = await api.getProcessedBookmarks(2000, {
        minWeight: weightMin,
        maxWeight: weightMax,
        source: sourceFilter,
        approval: approvalFilter,
      })
      setProcesados(data.processed)
      setCounts(data.counts)
    } catch {
      /* silent */
    }
  }, [weightMin, weightMax, sourceFilter, approvalFilter])

  const loadMediaDeps = useCallback(async () => {
    try {
      const d = await api.getBookmarkMediaDeps()
      setFfmpegOk(d.ffmpeg_ok)
      setOcrPending(d.ocr_pending)
      setCounts(d.counts)
    } catch {
      /* silent */
    }
  }, [])

  const refreshQueueStatus = useCallback(async () => {
    try {
      const st = await api.getBookmarkProcessStatus()
      setQueueStatus(st)
      setCounts(st.counts)
      return st
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void loadPending()
  }, [loadPending, refreshKey, shuffleNonce])

  useEffect(() => {
    if (stage === 'validados') void loadValidados()
  }, [stage, loadValidados, refreshKey])

  useEffect(() => {
    if (stage === 'procesados') {
      void loadProcesados()
      void loadMediaDeps()
    }
  }, [stage, loadProcesados, loadMediaDeps, refreshKey])

  useEffect(() => {
    void refreshQueueStatus()
  }, [refreshQueueStatus, refreshKey])

  // Poll cola mientras corre
  useEffect(() => {
    if (!queueStatus.running) return
    const t = window.setInterval(() => {
      void (async () => {
        const st = await refreshQueueStatus()
        if (!st) return
        if (!st.running) {
          if (stage === 'validados') void loadValidados()
          if (stage === 'procesados') void loadProcesados()
          onChanged?.()
        }
      })()
    }, 1500)
    return () => window.clearInterval(t)
  }, [
    queueStatus.running,
    refreshQueueStatus,
    stage,
    loadValidados,
    loadProcesados,
    onChanged,
  ])

  // Lazy download del reel al mostrar flashcard IG
  useEffect(() => {
    const current = queue[0]
    setMediaUrl(null)
    setMediaError(null)
    if (!current || current.source !== 'instagram') return

    const id = current.id
    const alreadyLocal = Boolean(current.local_media_path)
    let cancelled = false
    setMediaBusy(true)
    void (async () => {
      try {
        if (alreadyLocal) {
          if (!cancelled) {
            setMediaUrl(api.bookmarkMediaUrl(id))
            setMediaBusy(false)
          }
          return
        }
        const res = await api.ensureBookmarkMedia(id)
        if (cancelled) return
        if (res.ok && res.media_url) {
          setMediaUrl(res.media_url)
          setQueue((q) =>
            q.map((b) =>
              b.id === id
                ? {
                    ...b,
                    local_media_path:
                      res.local_media_path ?? b.local_media_path,
                  }
                : b,
            ),
          )
        } else {
          setMediaError(res.error || 'No se pudo cargar el video')
        }
      } catch (err) {
        if (!cancelled) {
          setMediaError(
            err instanceof Error ? err.message : 'Error descargando reel',
          )
        }
      } finally {
        if (!cancelled) setMediaBusy(false)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  const setOrder = (next: SortOrder) => {
    if (next === 'random') {
      setSortOrder('random')
      setShuffleNonce((n) => n + 1)
      return
    }
    if (next === sortOrder) return
    setSortOrder(next)
  }

  const exportWeighted = async () => {
    setBusy(true)
    setError(null)
    try {
      const lo = Math.min(weightMin, weightMax)
      const hi = Math.max(weightMin, weightMax)
      const payload = await api.exportBookmarks({
        minWeight: lo,
        maxWeight: hi,
        source: sourceFilter,
      })
      const day = new Date().toISOString().slice(0, 10)
      downloadJson(`deprocast-bookmarks-w${lo}-${hi}-${day}.json`, payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export fallido')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setSliderWeight(6)
  }, [currentId])

  const assignWeight = useCallback(
    async (weight: number) => {
      const current = queue[0]
      if (!current || assigning.current) return
      assigning.current = true
      setSliderWeight(weight)
      setError(null)

      const prev = queue
      setQueue((q) => q.slice(1))
      setValidados((list) => [
        { ...current, weight, status: 'CRIBADO' },
        ...list.filter((b) => b.id !== current.id),
      ])

      try {
        const res = await api.setBookmarkWeight(current.id, weight)
        setCounts(res.counts)
        if (prev.length <= 6) {
          void loadPending({ soft: true })
        }
        onChanged?.()
      } catch (err) {
        setQueue(prev)
        setValidados((list) => list.filter((b) => b.id !== current.id))
        setError(err instanceof Error ? err.message : 'Error al guardar peso')
      } finally {
        assigning.current = false
      }
    },
    [queue, loadPending, onChanged],
  )

  useEffect(() => {
    if (stage !== 'pendientes') return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.target as HTMLElement | null)?.isContentEditable) return
      const weight = keyToWeight(e)
      if (weight == null) return
      e.preventDefault()
      void assignWeight(weight)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [assignWeight, stage])

  const onDropFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    const file = list.find(
      (f) =>
        /\.(csv|json)$/i.test(f.name) ||
        f.type.includes('csv') ||
        f.type.includes('json'),
    )
    if (!file) {
      setError('Soltá un archivo .csv o .json')
      return
    }
    setBusy(true)
    setError(null)
    setImportHint(null)
    try {
      const res = await api.importBookmarksFile(file)
      setCounts(res.counts)
      const src = res.detected_source
      if (src === 'instagram') {
        setImportHint(
          `Instagram: +${res.imported} importados · ${res.updated} actualizados · ${res.skipped} omitidos`,
        )
        setSourceFilter('instagram')
      } else if (src === 'twitter') {
        setImportHint(
          `Twitter/X: +${res.imported} importados · ${res.updated} actualizados · ${res.skipped} omitidos`,
        )
        setSourceFilter('twitter')
      } else if (src === 'mixed') {
        setImportHint(
          `Mixto: +${res.imported} · ${res.updated} act. · ${res.skipped} omitidos`,
        )
        setSourceFilter('all')
      }
      await loadPending()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import fallido')
    } finally {
      setBusy(false)
    }
  }

  const startProcess = async () => {
    setError(null)
    try {
      const res = await api.startBookmarkProcess()
      setQueueStatus(res)
      setCounts(res.counts)
      if (res.queued === 0 && !res.running) {
        setError(res.message || 'Nada listo para procesar')
      }
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo iniciar')
    }
  }

  const stopProcess = async () => {
    try {
      const res = await api.stopBookmarkProcess()
      setQueueStatus(res)
      setCounts(res.counts)
      void loadValidados()
      void loadProcesados()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo detener')
    }
  }

  const approveAll = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.approveBookmarkQuantomos()
      setCounts(res.counts)
      await loadProcesados()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aprobación fallida')
    } finally {
      setBusy(false)
    }
  }

  const approveOne = async (quantomoId: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.approveBookmarkQuantomos([quantomoId])
      setCounts(res.counts)
      setProcesados((prev) =>
        approvalFilter === 'pending'
          ? prev.filter((p) => p.quantomo_id !== quantomoId)
          : prev.map((p) =>
              p.quantomo_id === quantomoId ? { ...p, recognized: 1 } : p,
            ),
      )
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aprobación fallida')
    } finally {
      setBusy(false)
    }
  }

  const reprocessOcrOne = async (id: string) => {
    setOcrBusyId(id)
    setError(null)
    try {
      const res = await api.reprocessBookmarkOcr(id)
      setFfmpegOk(true)
      setCounts(res.counts)
      setProcesados((list) =>
        list.map((p) =>
          p.id === id
            ? {
                ...p,
                title: res.item.title,
                quantomo_content: res.item.quantomo,
                category: res.item.category,
                ocr_frame_count: res.item.ocr_frame_count,
                needs_ocr: res.item.ocr_frame_count === 0,
              }
            : p,
        ),
      )
      setOcrPending((n) => Math.max(0, n - 1))
      onChanged?.()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Reproceso OCR fallido'
      setError(msg)
      if (/ffmpeg/i.test(msg)) setFfmpegOk(false)
    } finally {
      setOcrBusyId(null)
    }
  }

  const reprocessOcrMissing = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.reprocessBookmarkOcrBatch({ limit: 15 })
      setFfmpegOk(res.ffmpeg_ok)
      setOcrPending(res.ocr_pending)
      setCounts(res.counts)
      if (res.errors.length > 0 && res.processed === 0) {
        setError(
          res.errors[0]?.error ||
            `OCR falló en ${res.errors.length} ítems`,
        )
      } else if (res.errors.length > 0) {
        setImportHint(
          `OCR: ${res.processed} ok · ${res.skipped} con error · quedan ${res.ocr_pending}`,
        )
      } else {
        setImportHint(
          `OCR reprocesado: ${res.processed} · pendientes ${res.ocr_pending}`,
        )
      }
      await loadProcesados()
      onChanged?.()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Batch OCR fallido'
      setError(msg)
      if (/ffmpeg/i.test(msg)) setFfmpegOk(false)
    } finally {
      setBusy(false)
    }
  }

  const current = queue[0] ?? null
  const isIg = current?.source === 'instagram'
  const mediaUrls =
    current && !isIg ? parseMediaUrls(current.media_urls).slice(0, 4) : []
  const weightBand =
    sliderWeight <= 4 ? 'low' : sliderWeight <= 8 ? 'mid' : 'high'

  const validadosN = counts.validados ?? counts.high_value_ready
  const sinAprobarN = counts.sin_aprobar ?? counts.awaiting_approval
  const aprobadosN = counts.aprobados ?? 0
  const procesadosN = counts.procesados_ia ?? counts.procesados
  const needsOcrN = procesados.filter((p) => p.needs_ocr).length

  return (
    <section className="panel customs customs-active criba-panel">
      <header className="customs-toolbar criba-toolbar">
        <div className="customs-toolbar-left">
          <h2>Criba</h2>
          <p className="muted criba-counter">
            <span className="mono">{counts.pendientes}</span> sin validar
            {' · '}
            <span className="mono">{validadosN}</span> validados
            {' · '}
            <span className="mono">{procesadosN}</span> procesados
            {(counts.slop ?? 0) > 0 && (
              <>
                {' · '}
                <span className="mono">{counts.slop}</span> slop
              </>
            )}
          </p>
        </div>
        <div className="customs-toolbar-right">
          <div className="criba-order" role="group" aria-label="Fuente">
            {(
              [
                ['all', 'Todos'],
                ['twitter', 'Twitter'],
                ['instagram', 'Instagram'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`btn btn-tiny${sourceFilter === key ? ' is-nav-active' : ''}`}
                aria-pressed={sourceFilter === key}
                onClick={() => setSourceFilter(key)}
              >
                {label}
                {key !== 'all' && counts.by_source?.[key] != null && (
                  <span className="nav-badge">
                    {counts.by_source[key].pendientes}
                  </span>
                )}
              </button>
            ))}
          </div>
          {stage === 'pendientes' && (
            <div className="criba-order" role="group" aria-label="Orden">
              {(
                [
                  ['asc', 'Asc'],
                  ['desc', 'Desc'],
                  ['random', 'Azar'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`btn btn-tiny${sortOrder === key ? ' is-nav-active' : ''}`}
                  aria-pressed={sortOrder === key}
                  onClick={() => setOrder(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {(stage === 'validados' || stage === 'procesados') && (
            <label className="criba-weight-filter" title="Rango de peso">
              <span>w</span>
              <select
                value={weightMin}
                aria-label="Peso mínimo"
                onChange={(e) => setWeightMin(Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((w) => (
                  <option key={`min-${w}`} value={w}>
                    {w}
                  </option>
                ))}
              </select>
              <span>–</span>
              <select
                value={weightMax}
                aria-label="Peso máximo"
                onChange={(e) => setWeightMax(Number(e.target.value))}
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map((w) => (
                  <option key={`max-${w}`} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy || counts.cribados === 0}
            title="Descargar JSON con pesos en el rango"
            onClick={() => void exportWeighted()}
          >
            Descargar JSON
          </button>
          {queueStatus.running ? (
            <button
              type="button"
              className="btn btn-primary criba-queue-chip"
              title={queueStatus.current_title ?? 'Procesando en back'}
              onClick={() => void stopProcess()}
            >
              Detener ({queueStatus.done}/{queueStatus.target})
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={counts.high_value_ready === 0}
              title="Encola IA en el backend; podés seguir votando"
              onClick={() => void startProcess()}
            >
              Procesar validados
              {counts.high_value_ready > 0 && (
                <span className="nav-badge">{counts.high_value_ready}</span>
              )}
            </button>
          )}
        </div>
      </header>

      <div className="criba-stage-tabs" role="tablist" aria-label="Etapa">
        {(
          [
            ['pendientes', 'No validado', counts.pendientes],
            ['validados', 'Validado', validadosN],
            ['procesados', 'Procesado', procesadosN],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={stage === key}
            className={`criba-stage-tab${stage === key ? ' is-active' : ''}`}
            onClick={() => setStage(key)}
          >
            {label}
            <span className="nav-badge">{n}</span>
          </button>
        ))}
      </div>

      {queueStatus.running && (
        <p className="muted criba-queue-status">
          Back procesando{' '}
          <span className="mono">
            {queueStatus.done}/{queueStatus.target}
          </span>
          {queueStatus.current_title
            ? ` · ${oneLine(queueStatus.current_title, 60)}`
            : ''}
          {' · '}
          podés seguir votando
        </p>
      )}

      {(error || importHint) && (
        <div className="criba-messages">
          {error && <p className="criba-error">{error}</p>}
          {importHint && !error && (
            <p className="muted criba-import-hint">{importHint}</p>
          )}
        </div>
      )}

      {stage === 'validados' && (
        <div className="criba-scored-view">
          <p className="muted criba-scored-meta">
            Validados (CRIBADO) · pesos{' '}
            <span className="mono">
              {Math.min(weightMin, weightMax)}–{Math.max(weightMin, weightMax)}
            </span>
            {' · '}
            <span className="mono">{validados.length}</span> ítems
          </p>
          {validados.length === 0 ? (
            <p className="muted criba-scored-empty">
              No hay validados en ese rango. Votá en No validado.
            </p>
          ) : (
            <ul className="criba-scored-list">
              {validados.map((b) => (
                <li key={b.id} className="criba-scored-row">
                  <span className="mono criba-w">w{b.weight ?? '—'}</span>
                  {b.source === 'instagram' && (
                    <span className="criba-source-tag">IG</span>
                  )}
                  <span className="criba-scored-text" title={b.text}>
                    {oneLine(b.text)}
                  </span>
                  {b.link && (
                    <a
                      className="criba-link"
                      href={b.link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      abrir
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Dropzone busy={busy} onFiles={(f) => void onDropFiles(f)} />
        </div>
      )}

      {stage === 'procesados' && (
        <div className="criba-scored-view">
          <div className="criba-approval-tabs" role="tablist">
            <button
              type="button"
              className={`btn btn-tiny${approvalFilter === 'pending' ? ' is-nav-active' : ''}`}
              aria-pressed={approvalFilter === 'pending'}
              onClick={() => setApprovalFilter('pending')}
            >
              Sin aprobar
              {sinAprobarN > 0 && (
                <span className="nav-badge">{sinAprobarN}</span>
              )}
            </button>
            <button
              type="button"
              className={`btn btn-tiny${approvalFilter === 'approved' ? ' is-nav-active' : ''}`}
              aria-pressed={approvalFilter === 'approved'}
              onClick={() => setApprovalFilter('approved')}
            >
              Aprobados
              {aprobadosN > 0 && (
                <span className="nav-badge">{aprobadosN}</span>
              )}
            </button>
            {approvalFilter === 'pending' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || procesados.length === 0}
                onClick={() => void approveAll()}
              >
                Aprobar todo
              </button>
            )}
            <button
              type="button"
              className="btn btn-tiny"
              disabled={
                busy ||
                ocrBusyId != null ||
                (needsOcrN === 0 && ocrPending === 0)
              }
              title={
                ffmpegOk === false
                  ? 'Falta ffmpeg.exe en %USERPROFILE%\\bin o tools\\'
                  : 'Fotogramas + Vision + re-extract (IG w≥10 sin OCR)'
              }
              onClick={() => void reprocessOcrMissing()}
            >
              Reprocesar OCR
              {(ocrPending > 0 || needsOcrN > 0) && (
                <span className="nav-badge">
                  {ocrPending || needsOcrN}
                </span>
              )}
            </button>
            {ffmpegOk === false && (
              <span className="muted criba-ffmpeg-warn" title="FFMPEG_PATH / bin / tools">
                sin ffmpeg
              </span>
            )}
          </div>
          <p className="muted criba-scored-meta">
            Procesados · pesos{' '}
            <span className="mono">
              {Math.min(weightMin, weightMax)}–{Math.max(weightMin, weightMax)}
            </span>
            {' · '}
            <span className="mono">{procesados.length}</span> ítems
            {needsOcrN > 0 && (
              <>
                {' · '}
                <span className="mono">{needsOcrN}</span> sin OCR
              </>
            )}
          </p>
          {procesados.length === 0 ? (
            <p className="muted criba-scored-empty">
              {approvalFilter === 'pending'
                ? 'Nada pendiente de aprobar en ese rango.'
                : 'Nada aprobado aún en ese rango.'}
            </p>
          ) : (
            <ul className="criba-approve-list">
              {procesados.map((q) => (
                <li
                  key={q.quantomo_id ?? q.id}
                  className="criba-approve-row"
                >
                  <div className="criba-approve-meta">
                    <span className="mono criba-w">w{q.weight ?? '—'}</span>
                    {q.source === 'instagram' && (
                      <span className="criba-source-tag">IG</span>
                    )}
                    {q.category && (
                      <span className="criba-cat">{q.category}</span>
                    )}
                    {(q.weight ?? 0) >= 10 && q.source === 'instagram' && (
                      <span
                        className={`criba-ocr-badge${q.needs_ocr ? ' is-missing' : ''}`}
                        title={
                          q.needs_ocr
                            ? 'Sin fotogramas Vision'
                            : `${q.ocr_frame_count ?? 0} frames OCR`
                        }
                      >
                        {q.needs_ocr
                          ? 'OCR?'
                          : `OCR×${q.ocr_frame_count ?? 0}`}
                      </span>
                    )}
                    <span className="criba-approve-title">
                      {q.title || oneLine(q.text, 60)}
                    </span>
                  </div>
                  <p className="criba-approve-body">
                    {q.quantomo_content || oneLine(q.text, 160) || '—'}
                  </p>
                  {approvalFilter === 'pending' && q.quantomo_id && (
                    <button
                      type="button"
                      className="btn btn-tiny"
                      disabled={busy || ocrBusyId != null}
                      onClick={() => void approveOne(q.quantomo_id!)}
                    >
                      Aprobar
                    </button>
                  )}
                  {q.source === 'instagram' && (q.weight ?? 0) >= 10 && (
                    <button
                      type="button"
                      className="btn btn-tiny"
                      disabled={busy || ocrBusyId != null}
                      onClick={() => void reprocessOcrOne(q.id)}
                    >
                      {ocrBusyId === q.id ? 'OCR…' : 'Reprocesar OCR'}
                    </button>
                  )}
                  {q.link && (
                    <a
                      className="criba-link"
                      href={q.link}
                      target="_blank"
                      rel="noreferrer"
                    >
                      abrir
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {stage === 'pendientes' && (
        <div className="criba-stage">
          <div className="criba-fire">
            {current ? (
              <div className="criba-workbench">
                <article
                  key={currentId}
                  className={`criba-card${weightBand === 'high' ? ' is-high' : ''}${
                    isIg || mediaUrls.length > 0 ? ' has-media' : ''
                  }${isIg ? ' is-ig-flashcard' : ''}`}
                >
                  <header className="criba-card-meta">
                    {isIg && (
                      <span className="criba-source-tag">Instagram</span>
                    )}
                    <span className="criba-author">
                      {(() => {
                        const name = current.author_name?.trim() || ''
                        const user = current.author_username?.trim() || ''
                        if (user && (!name || /^\d+$/.test(name))) {
                          return `@${user}`
                        }
                        if (name && user) return `${name} · @${user}`
                        if (name) return name
                        if (user) return `@${user}`
                        return 'Sin autor'
                      })()}
                    </span>
                    {current.created_at_source && (
                      <span className="criba-date">
                        {formatBookmarkDate(current.created_at_source)}
                      </span>
                    )}
                    {current.link && (
                      <a
                        className="criba-link"
                        href={current.link}
                        target="_blank"
                        rel="noreferrer"
                      >
                        abrir
                      </a>
                    )}
                  </header>

                  {isIg ? (
                    <div className="criba-flashcard">
                      <div className="criba-flashcard-video">
                        {mediaUrl ? (
                          <video
                            key={mediaUrl}
                            className="criba-video"
                            src={mediaUrl}
                            controls
                            autoPlay
                            muted
                            loop
                            playsInline
                          />
                        ) : current.shortcode && !mediaBusy ? (
                          <div className="criba-embed-wrap">
                            <iframe
                              className="criba-ig-embed"
                              title={`Reel ${current.shortcode}`}
                              src={`https://www.instagram.com/reel/${current.shortcode}/embed`}
                              allow="autoplay; encrypted-media"
                              loading="lazy"
                              referrerPolicy="strict-origin-when-cross-origin"
                            />
                            {mediaError && (
                              <p className="muted criba-media-hint">
                                Local: {mediaError}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="criba-video-placeholder">
                            {mediaBusy
                              ? 'Descargando reel…'
                              : mediaError || 'Video no disponible'}
                            {current.link && (
                              <a
                                className="criba-link"
                                href={current.link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Abrir en Instagram
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="criba-flashcard-desc">
                        <p className="criba-text">{current.text}</p>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`criba-card-body${
                        mediaUrls.length > 0 ? ' has-media' : ''
                      }`}
                    >
                      <p className="criba-text">{current.text}</p>
                      {mediaUrls.length > 0 && (
                        <div
                          className={`criba-media${
                            mediaUrls.length === 1 ? ' is-single' : ''
                          }`}
                        >
                          {mediaUrls.map((url) => (
                            <a
                              key={url}
                              className="criba-media-link"
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              title="Abrir imagen"
                            >
                              <img
                                src={url}
                                alt=""
                                className="criba-media-img"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="criba-slider-wrap" data-band={weightBand}>
                    <div className="criba-slider-head">
                      <span className="criba-slider-label">Peso</span>
                      <span className="mono criba-slider-value">
                        {sliderWeight}
                      </span>
                    </div>
                    <input
                      type="range"
                      className="criba-slider"
                      min={1}
                      max={12}
                      step={1}
                      value={sliderWeight}
                      aria-label="Peso 1 a 12"
                      onChange={(e) =>
                        setSliderWeight(Number(e.target.value))
                      }
                      onPointerUp={(e) => {
                        const w = Number((e.target as HTMLInputElement).value)
                        void assignWeight(w)
                      }}
                      onKeyUp={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          const w = Number(
                            (e.target as HTMLInputElement).value,
                          )
                          void assignWeight(w)
                        }
                      }}
                    />
                    <div className="criba-slider-bands" aria-hidden>
                      <span>1–4</span>
                      <span>5–8</span>
                      <span>9–12</span>
                    </div>
                    <div className="criba-slider-ticks" aria-hidden>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((w) => (
                        <span
                          key={w}
                          className={
                            w === sliderWeight ? 'is-active' : undefined
                          }
                        >
                          {w}
                        </span>
                      ))}
                    </div>
                  </div>
                </article>
                <CribaNotePanel
                  bookmark={current}
                  onUpdated={(next) => {
                    setQueue((q) =>
                      q.map((b) => (b.id === next.id ? { ...b, ...next } : b)),
                    )
                  }}
                />
              </div>
            ) : (
              <div className="criba-empty">
                <p>
                  {counts.total === 0
                    ? 'Importá un CSV/JSON (Twitter o Instagram) para empezar la criba.'
                    : 'No hay pendientes. Revisá Validado o importá más.'}
                </p>
              </div>
            )}
          </div>

          <Dropzone busy={busy} onFiles={(f) => void onDropFiles(f)} />
        </div>
      )}
    </section>
  )
}
