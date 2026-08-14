import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

export type MentionKind = 'person' | 'project' | 'agrupacion'

export type MentionMenuHit = {
  kind: MentionKind
  entity_id: string
  entity_name: string
  subtitle: string
}

export function mentionKindLabel(kind: MentionKind): string {
  if (kind === 'agrupacion') return 'Grupo'
  if (kind === 'project') return 'Proyecto'
  return 'Persona'
}

type Anchor = { top: number; left: number; height: number }

type Props = {
  open: boolean
  hits: MentionMenuHit[]
  activeIdx: number
  busy: boolean
  anchor: Anchor | null
  taggedIds?: Set<string>
  onHoverIdx: (idx: number) => void
  onPick: (hit: MentionMenuHit, multi: boolean) => void
}

const MENU_W = 300
const MENU_MAX_H = 260
const GAP = 8

function menuStyle(anchor: Anchor): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const spaceBelow = vh - (anchor.top + anchor.height) - 12
  const placeBelow = spaceBelow >= 140 || spaceBelow >= anchor.top
  const top = placeBelow
    ? anchor.top + anchor.height + GAP
    : Math.max(8, anchor.top - MENU_MAX_H - GAP)
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, vw - MENU_W - 8))
  return { top, left }
}

export function MentionMenu({
  open,
  hits,
  activeIdx,
  busy,
  anchor,
  taggedIds,
  onHoverIdx,
  onPick,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const style = useMemo(
    () => (anchor ? menuStyle(anchor) : undefined),
    [anchor],
  )

  useEffect(() => {
    if (!open) return
    const active = listRef.current?.querySelector('[aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIdx])

  if (!open || !anchor || !style) return null

  return createPortal(
    <div
      ref={listRef}
      className="mention-pop"
      role="listbox"
      aria-label="Entidades para etiquetar"
      style={style}
    >
      <header className="mention-pop-head">
        <span className="mention-pop-title">Etiquetar</span>
        <span className="mention-pop-hint">Ctrl suma otra</span>
      </header>
      {busy && hits.length === 0 && (
        <p className="muted mention-pop-empty">Buscando…</p>
      )}
      {!busy && hits.length === 0 && (
        <p className="muted mention-pop-empty">Sin coincidencias</p>
      )}
      {hits.map((hit, i) => {
        const tagged = taggedIds?.has(`${hit.kind}:${hit.entity_id}`)
        return (
          <button
            key={`${hit.kind}:${hit.entity_id}`}
            type="button"
            role="option"
            aria-selected={i === activeIdx}
            className={`mention-pop-item kind-${hit.kind}${
              i === activeIdx ? ' is-active' : ''
            }${tagged ? ' is-tagged' : ''}`}
            onMouseEnter={() => onHoverIdx(i)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(hit, e.ctrlKey || e.metaKey)
            }}
          >
            <span className={`mention-pop-kind kind-${hit.kind}`}>
              {mentionKindLabel(hit.kind)}
            </span>
            <span className="mention-pop-name">{hit.entity_name}</span>
            <span className="muted mention-pop-sub">{hit.subtitle}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
