import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { api } from '../services/api'
import type { BlobNote, BlobTag, BlobTagKind } from '../types'
import {
  MentionMenu,
  mentionKindLabel,
  type MentionMenuHit,
} from './MentionMenu'
import { getTextareaCaretRect } from '../lib/textareaCaret'

type Props = {
  onChanged?: () => void
}

function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && /[\wÀ-ÿ]/.test(before[at - 1] ?? '')) return null
  const fragment = before.slice(at + 1)
  if (/[\s\n]/.test(fragment)) return null
  if (fragment.length > 48) return null
  return { start: at, query: fragment }
}

function kindLabel(kind: BlobTagKind): string {
  return mentionKindLabel(kind)
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 16)
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function BlobComposer({ onChanged }: Props) {
  const [text, setText] = useState('')
  const [tags, setTags] = useState<BlobTag[]>([])
  const [blobs, setBlobs] = useState<BlobNote[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionHits, setMentionHits] = useState<MentionMenuHit[]>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const [mentionBusy, setMentionBusy] = useState(false)
  const [mentionRange, setMentionRange] = useState<{
    start: number
    end: number
  } | null>(null)
  const [mentionAnchor, setMentionAnchor] = useState<{
    top: number
    left: number
    height: number
  } | null>(null)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchAbort = useRef<AbortController | null>(null)

  const loadBlobs = useCallback(async () => {
    try {
      const data = await api.listBlobs(40)
      setBlobs(data.blobs)
    } catch (err) {
      console.error(err)
    }
  }, [])

  useEffect(() => {
    void loadBlobs()
    const t = window.setTimeout(() => taRef.current?.focus(), 80)
    return () => window.clearTimeout(t)
  }, [loadBlobs])

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchAbort.current?.abort()
    }
  }, [])

  const runMentionSearch = useCallback((query: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchAbort.current?.abort()
    setMentionBusy(true)
    searchTimer.current = setTimeout(() => {
      const ac = new AbortController()
      searchAbort.current = ac
      void (async () => {
        try {
          const res = await api.typeaheadEntities(query, {
            kinds: ['person', 'agrupacion', 'project'],
            limit: 12,
            scope: 'all',
            signal: ac.signal,
          })
          if (ac.signal.aborted) return
          const hits: MentionMenuHit[] = res.results
            .filter(
              (h): h is typeof h & { kind: BlobTagKind } =>
                h.kind === 'person' ||
                h.kind === 'project' ||
                h.kind === 'agrupacion',
            )
            .map((h) => ({
              kind: h.kind,
              entity_id: h.id,
              entity_name: h.label,
              subtitle: h.subtitle,
            }))
          setMentionHits(hits)
          setMentionIdx(0)
        } catch (err) {
          if (ac.signal.aborted) return
          if (err instanceof DOMException && err.name === 'AbortError') return
          setMentionHits([])
        } finally {
          if (!ac.signal.aborted) setMentionBusy(false)
        }
      })()
    }, 80)
  }, [])

  const syncMentionAnchor = useCallback((offset?: number) => {
    const ta = taRef.current
    if (!ta) return
    setMentionAnchor(getTextareaCaretRect(ta, offset ?? ta.selectionStart))
  }, [])

  const applyMention = useCallback(
    (hit: MentionMenuHit, multi = false) => {
      const ta = taRef.current
      if (!ta || !mentionRange) return
      const before = text.slice(0, mentionRange.start)
      const after = text.slice(mentionRange.end)
      const insert = multi ? `@${hit.entity_name} @` : `@${hit.entity_name} `
      const nextText = `${before}${insert}${after}`
      const nextTags = [
        ...tags.filter(
          (t) => !(t.kind === hit.kind && t.entity_id === hit.entity_id),
        ),
        {
          kind: hit.kind,
          entity_id: hit.entity_id,
          entity_name: hit.entity_name,
        },
      ]
      setText(nextText)
      setTags(nextTags)

      const caret = before.length + insert.length
      if (multi) {
        setMentionRange({ start: caret - 1, end: caret })
        setMentionOpen(true)
        runMentionSearch('')
      } else {
        setMentionOpen(false)
        setMentionHits([])
        setMentionRange(null)
        setMentionAnchor(null)
      }

      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(caret, caret)
        if (multi) syncMentionAnchor(caret)
      })
    },
    [mentionRange, text, tags, runMentionSearch, syncMentionAnchor],
  )

  const removeTag = (tag: BlobTag) => {
    setTags((prev) =>
      prev.filter(
        (t) => !(t.kind === tag.kind && t.entity_id === tag.entity_id),
      ),
    )
  }

  const onTextChange = (value: string) => {
    setText(value)
    const ta = taRef.current
    const caret = ta?.selectionStart ?? value.length
    const mq = mentionQueryAt(value, caret)
    if (mq) {
      setMentionOpen(true)
      setMentionRange({ start: mq.start, end: caret })
      runMentionSearch(mq.query)
      syncMentionAnchor(caret)
    } else {
      setMentionOpen(false)
      setMentionHits([])
      setMentionRange(null)
      setMentionAnchor(null)
    }
  }

  const submit = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    const timestamp_exact = new Date().toISOString()
    setBusy(true)
    setError(null)
    try {
      const res = await api.ingestBlob({
        text: trimmed,
        timestamp_exact,
        tags,
      })
      setText('')
      setTags([])
      setMentionOpen(false)
      setMentionHits([])
      setMentionRange(null)
      setMentionAnchor(null)
      setBlobs((prev) => [res.blob, ...prev.filter((b) => b.id !== res.blob.id)])
      onChanged?.()
      requestAnimationFrame(() => taRef.current?.focus())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar')
    } finally {
      setBusy(false)
    }
  }, [text, tags, busy, onChanged])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (mentionHits.length > 0) {
          setMentionIdx((i) => (i + 1) % mentionHits.length)
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (mentionHits.length > 0) {
          setMentionIdx(
            (i) => (i - 1 + mentionHits.length) % mentionHits.length,
          )
        }
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && mentionHits.length > 0) {
        e.preventDefault()
        applyMention(mentionHits[mentionIdx]!, e.ctrlKey || e.metaKey)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (
          mentionRange &&
          text.slice(mentionRange.start, mentionRange.end) === '@'
        ) {
          const next = `${text.slice(0, mentionRange.start)}${text.slice(mentionRange.end)}`
          setText(next)
        }
        setMentionOpen(false)
        setMentionHits([])
        setMentionRange(null)
        setMentionAnchor(null)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${Math.max(72, Math.min(ta.scrollHeight, 220))}px`
    if (mentionOpen) syncMentionAnchor()
  }, [text, mentionOpen, syncMentionAnchor])

  useEffect(() => {
    if (!mentionOpen) return
    const onMove = () => syncMentionAnchor()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [mentionOpen, syncMentionAnchor])

  async function handleDelete(id: string) {
    try {
      await api.deleteEntry(id)
      setBlobs((prev) => prev.filter((b) => b.id !== id))
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo eliminar')
    }
  }

  const canSend = text.trim().length > 0 && !busy
  const taggedIds = useMemo(
    () => new Set(tags.map((t) => `${t.kind}:${t.entity_id}`)),
    [tags],
  )

  return (
    <div className="blob-capture">
      <div className="blob-composer">
        <label className="blob-composer-label" htmlFor="blob-input">
          Nota en bruto
        </label>
        <div className="blob-composer-box">
          <textarea
            id="blob-input"
            ref={taRef}
            className="blob-composer-textarea"
            value={text}
            placeholder="Pegá texto tal cual. @ etiquetá personas, grupos o proyectos. Enter envía."
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            onScroll={() => {
              if (mentionOpen) syncMentionAnchor()
            }}
            onClick={() => {
              if (mentionOpen) syncMentionAnchor()
            }}
            disabled={busy}
            spellCheck
          />
          <MentionMenu
            open={mentionOpen}
            hits={mentionHits}
            activeIdx={mentionIdx}
            busy={mentionBusy}
            anchor={mentionAnchor}
            taggedIds={taggedIds}
            onHoverIdx={setMentionIdx}
            onPick={applyMention}
          />
        </div>

        {tags.length > 0 && (
          <ul className="criba-note-tags blob-composer-tags">
            {tags.map((tag) => (
              <li key={`${tag.kind}:${tag.entity_id}`}>
                <span className="criba-note-tag" title={kindLabel(tag.kind)}>
                  <span className="criba-note-tag-kind">@</span>
                  {tag.entity_name}
                  <button
                    type="button"
                    className="criba-note-tag-x"
                    aria-label={`Quitar ${tag.entity_name}`}
                    onClick={() => removeTag(tag)}
                  >
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="blob-composer-foot">
          <p className="muted blob-composer-hint">
            El texto se guarda literal. @ abre entidades junto al cursor. Ctrl+clic o Ctrl+Enter suma otra. Enter envía (Shift+Enter: línea nueva).
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSend}
            onClick={() => void submit()}
          >
            {busy ? 'Guardando…' : 'Enviar'}
          </button>
        </div>
        {error && <p className="status-line err">{error}</p>}
      </div>

      {blobs.length > 0 && (
        <ul className="blob-feed">
          {blobs.map((b) => (
            <li key={b.id} className="blob-card">
              <div className="blob-card-meta">
                <time className="mono blob-card-ts" dateTime={b.timestamp_exact}>
                  {formatTs(b.timestamp_exact)}
                </time>
                <button
                  type="button"
                  className="btn btn-tiny danger-text"
                  onClick={() => void handleDelete(b.id)}
                >
                  Eliminar
                </button>
              </div>
              <p className="blob-card-body">{b.content_raw}</p>
              {(b.quantomos ?? []).length > 0 && (
                <ul className="blob-quantomos">
                  {(b.quantomos ?? []).map((q) => (
                    <li key={q.id}>
                      <span className="blob-quantomo-kicker">Quántomo</span>
                      <strong>{q.title}</strong>
                      {q.content && q.content !== b.content_raw && (
                        <span className="muted">{q.content}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {b.tags.length > 0 && (
                <ul className="criba-note-tags">
                  {b.tags.map((tag) => (
                    <li key={`${tag.kind}:${tag.entity_id}`}>
                      <span
                        className="criba-note-tag"
                        title={kindLabel(tag.kind)}
                      >
                        <span className="criba-note-tag-kind">@</span>
                        {tag.entity_name}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
