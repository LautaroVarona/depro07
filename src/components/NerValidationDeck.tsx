import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import type { EntityProposalView } from '../types'

export type NerDeckVariant = 'person' | 'project'

export interface NerClassOption {
  value: string
  label: string
}

interface Props {
  open: boolean
  onClose: () => void
  variant: NerDeckVariant
  proposals: EntityProposalView[]
  names: Record<string, string>
  classes: Record<string, string>
  classOptions: NerClassOption[]
  onNameChange: (id: string, value: string) => void
  onClassChange: (id: string, value: string) => void
  onDiscard: (p: EntityProposalView) => void | Promise<void>
  onWaiting: (p: EntityProposalView) => void | Promise<void>
  onLink: (p: EntityProposalView, targetId: string) => void | Promise<void>
}

const SWIPE_COMMIT = 110

function originLabel(p: EntityProposalView): string {
  const title = p.entry?.title || p.entry_title || p.evidence_parsed.entry_title
  const source = p.entry?.source_type
  const file = p.entry?.original_filename
  const parts = [
    title?.trim() || null,
    source ? `origen: ${source}` : null,
    file ? file : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Sin origen'
}

function highlightMention(text: string, mention: string): ReactNode {
  const needle = mention.trim()
  if (!text || !needle) return text
  const lower = text.toLowerCase()
  const idx = lower.indexOf(needle.toLowerCase())
  if (idx < 0) return text
  const before = text.slice(0, idx)
  const hit = text.slice(idx, idx + needle.length)
  const after = text.slice(idx + needle.length)
  return (
    <>
      {before}
      <mark className="ner-deck-mark">{hit}</mark>
      {after}
    </>
  )
}

export function NerValidationDeck({
  open,
  onClose,
  variant,
  proposals,
  names,
  classes,
  classOptions,
  onNameChange,
  onClassChange,
  onDiscard,
  onWaiting,
  onLink,
}: Props) {
  const current = proposals[0] ?? null
  const restCount = Math.max(0, proposals.length - 1)

  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [fly, setFly] = useState<'left' | 'right' | null>(null)
  const startXRef = useRef(0)
  const dragXRef = useRef(0)
  const lockRef = useRef(false)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const currentRef = useRef(current)
  currentRef.current = current

  useEffect(() => {
    setDragX(0)
    setFly(null)
    lockRef.current = false
  }, [current?.id])

  const commit = useCallback(
    async (dir: 'left' | 'right') => {
      const p = currentRef.current
      if (!p || lockRef.current) return
      lockRef.current = true
      setFly(dir)
      await new Promise((r) => window.setTimeout(r, 180))
      try {
        if (dir === 'left') await onDiscard(p)
        else await onWaiting(p)
      } finally {
        setFly(null)
        setDragX(0)
        lockRef.current = false
      }
    },
    [onDiscard, onWaiting],
  )

  const commitLink = useCallback(async () => {
    const p = currentRef.current
    if (!p?.suggested_match || lockRef.current) return
    lockRef.current = true
    setFly('right')
    await new Promise((r) => window.setTimeout(r, 160))
    try {
      await onLink(p, p.suggested_match.id)
    } finally {
      setFly(null)
      setDragX(0)
      lockRef.current = false
    }
  }, [onLink])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (lockRef.current) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'Escape') {
        onClose()
        return
      }
      const p = currentRef.current
      if (!p) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        void commit('left')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        void commit('right')
      } else if (e.key === 'ArrowUp' && p.suggested_match) {
        e.preventDefault()
        void commitLink()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, commit, commitLink])

  if (!open) return null

  const name = current
    ? (names[current.id] ?? current.suggested_name)
    : ''
  const klass = current
    ? (classes[current.id] ??
      String(
        variant === 'person'
          ? (current.meta.kind ?? 'fisica')
          : (current.meta.category ?? 'proyecto'),
      ))
    : ''
  const match = current?.suggested_match ?? null
  const body =
    current?.evidence_parsed.context ||
    current?.evidence_parsed.snippet ||
    ''

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!current || lockRef.current) return
    const el = e.target as HTMLElement
    if (el.closest('input, select, textarea, button, a, label')) return
    startXRef.current = e.clientX
    dragXRef.current = 0
    setDragging(true)
    cardRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const x = e.clientX - startXRef.current
    dragXRef.current = x
    setDragX(x)
  }

  const onPointerUp = () => {
    if (!dragging) return
    setDragging(false)
    const x = dragXRef.current
    if (x <= -SWIPE_COMMIT) void commit('left')
    else if (x >= SWIPE_COMMIT) void commit('right')
    else {
      setDragX(0)
      dragXRef.current = 0
    }
  }

  const displayX =
    fly === 'left' ? -480 : fly === 'right' ? 480 : dragX
  const rot = Math.max(-12, Math.min(12, displayX / 18))
  const discardHint = displayX < -40
  const keepHint = displayX > 40

  return (
    <div className="ner-deck-overlay" role="dialog" aria-modal="true">
      <div className="ner-deck-shell">
        <header className="ner-deck-head">
          <div>
            <h2>Validación NER</h2>
            <p className="muted mono">
              {variant === 'person' ? 'Personas' : 'Proyectos'}
              {proposals.length > 0
                ? ` · ${proposals.length} pendientes`
                : ' · listo'}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-tiny btn-ghost"
            onClick={onClose}
          >
            Cerrar
          </button>
        </header>

        {current ? (
          <>
            {match ? (
              <button
                type="button"
                className="btn btn-primary ner-deck-link-top"
                onClick={() => void commitLink()}
              >
                Vincular a {match.name}
                {match.score > 0 ? (
                  <span className="mono ner-deck-score">
                    {Math.round(match.score * 100)}%
                  </span>
                ) : null}
              </button>
            ) : (
              <div className="ner-deck-link-top is-empty muted mono">
                Sin vínculo sugerido · ← descartar · → sala de espera
              </div>
            )}

            <div className="ner-deck-stage">
              {restCount > 0 ? (
                <div className="ner-deck-stack" aria-hidden>
                  <div className="ner-deck-ghost" />
                  {restCount > 1 ? (
                    <div className="ner-deck-ghost is-deeper" />
                  ) : null}
                </div>
              ) : null}

              <div
                ref={cardRef}
                className={[
                  'ner-deck-card',
                  dragging ? 'is-dragging' : '',
                  fly ? `is-fly-${fly}` : '',
                  discardHint ? 'hint-discard' : '',
                  keepHint ? 'hint-keep' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  transform: `translateX(${displayX}px) rotate(${rot}deg)`,
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <div className="ner-deck-stamp ner-deck-stamp-discard">
                  Descartar
                </div>
                <div className="ner-deck-stamp ner-deck-stamp-keep">
                  Sala de espera
                </div>

                <label className="field">
                  <span className="mono">Mención</span>
                  <input
                    value={name}
                    onChange={(e) => onNameChange(current.id, e.target.value)}
                  />
                </label>

                <label className="field">
                  <span className="mono">Clasificar</span>
                  <select
                    value={klass}
                    onChange={(e) => onClassChange(current.id, e.target.value)}
                  >
                    {classOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="ner-deck-origin">
                  <span className="mono">Origen</span>
                  <p>{originLabel(current)}</p>
                </div>

                <div className="ner-deck-body">
                  <span className="mono">Contexto</span>
                  <blockquote>
                    {body
                      ? highlightMention(body, name || current.suggested_name)
                      : 'Sin texto de contexto'}
                  </blockquote>
                </div>
              </div>
            </div>

            <div className="ner-deck-actions">
              <button
                type="button"
                className="btn ner-deck-btn ner-deck-btn-discard"
                onClick={() => void commit('left')}
                title="Descartar (←)"
              >
                ← Descartar
              </button>
              <button
                type="button"
                className="btn btn-primary ner-deck-btn ner-deck-btn-keep"
                onClick={() => void commit('right')}
                title="Sala de espera (→)"
              >
                Sala de espera →
              </button>
            </div>
            <p className="ner-deck-hint muted mono">
              Arrastrá la card · ← descartar · → sala
              {match ? ' · ↑ vincular' : ''}
            </p>
          </>
        ) : (
          <div className="ner-deck-empty">
            <p>No quedan menciones pendientes.</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Volver
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
