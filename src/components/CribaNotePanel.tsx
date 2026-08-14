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
import type { Bookmark, BookmarkManualTag } from '../types'
import { MentionMenu, type MentionMenuHit } from './MentionMenu'
import { getTextareaCaretRect } from '../lib/textareaCaret'

type Props = {
  bookmark: Bookmark
  onUpdated: (next: Bookmark) => void
}

function parseTags(raw: string | null | undefined): BookmarkManualTag[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is BookmarkManualTag =>
        !!t &&
        typeof t === 'object' &&
        (t.kind === 'person' || t.kind === 'project') &&
        typeof t.entity_id === 'string' &&
        typeof t.entity_name === 'string',
    )
  } catch {
    return []
  }
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

export function CribaNotePanel({ bookmark, onUpdated }: Props) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState(bookmark.operator_note ?? '')
  const [tags, setTags] = useState<BookmarkManualTag[]>(() =>
    parseTags(bookmark.manual_tags),
  )
  const [saveState, setSaveState] = useState<
    'idle' | 'dirty' | 'saving' | 'error'
  >('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
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
  const popRef = useRef<HTMLDivElement>(null)
  const noteRef = useRef(note)
  const tagsRef = useRef(tags)
  const bookmarkIdRef = useRef(bookmark.id)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchAbort = useRef<AbortController | null>(null)
  const dirty = useRef(false)

  noteRef.current = note
  tagsRef.current = tags
  bookmarkIdRef.current = bookmark.id

  useEffect(() => {
    setNote(bookmark.operator_note ?? '')
    setTags(parseTags(bookmark.manual_tags))
    dirty.current = false
    setOpen(false)
    setMentionOpen(false)
    setMentionHits([])
    setMentionRange(null)
    setMentionAnchor(null)
    setSaveError(null)
    setSaveState('idle')
  }, [bookmark.id])

  useEffect(() => {
    setNote(bookmark.operator_note ?? '')
    setTags(parseTags(bookmark.manual_tags))
  }, [bookmark.operator_note, bookmark.manual_tags])

  const persist = useCallback(
    async (nextNote: string, nextTags: BookmarkManualTag[]) => {
      const id = bookmarkIdRef.current
      setSaveState('saving')
      setSaveError(null)
      try {
        const res = await api.updateBookmarkNote(id, {
          operator_note: nextNote,
          manual_tags: nextTags,
        })
        dirty.current = false
        setSaveState('idle')
        onUpdated(res.bookmark)
      } catch (err) {
        setSaveState('error')
        setSaveError(
          err instanceof Error ? err.message : 'No se pudo guardar la nota',
        )
      }
    },
    [onUpdated],
  )

  const scheduleSave = useCallback(
    (nextNote: string, nextTags: BookmarkManualTag[]) => {
      dirty.current = true
      setSaveState('dirty')
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        void persist(nextNote, nextTags)
      }, 450)
    },
    [persist],
  )

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchAbort.current?.abort()
      if (dirty.current) {
        void api
          .updateBookmarkNote(bookmarkIdRef.current, {
            operator_note: noteRef.current,
            manual_tags: tagsRef.current,
          })
          .catch(() => {
            /* best effort */
          })
      }
    }
  }, [bookmark.id])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (popRef.current?.contains(t)) return
      if (t instanceof Element && t.closest('.mention-pop')) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (mentionOpen) {
        setMentionOpen(false)
        setMentionHits([])
        setMentionRange(null)
        setMentionAnchor(null)
        return
      }
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, mentionOpen])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => taRef.current?.focus(), 30)
    return () => window.clearTimeout(t)
  }, [open, bookmark.id])

  const runMentionSearch = useCallback((query: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchAbort.current?.abort()
    if (!query.trim()) {
      setMentionBusy(false)
      return
    }
    setMentionBusy(true)
    searchTimer.current = setTimeout(() => {
      const ac = new AbortController()
      searchAbort.current = ac
      void (async () => {
        try {
          const res = await api.typeaheadEntities(query, {
            kinds: ['person', 'project'],
            limit: 10,
            scope: 'masters',
            signal: ac.signal,
          })
          if (ac.signal.aborted) return
          const hits: MentionMenuHit[] = res.results.map((h) => ({
            kind: h.kind === 'project' ? 'project' : 'person',
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
    }, 150)
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
      const before = note.slice(0, mentionRange.start)
      const after = note.slice(mentionRange.end)
      const insert = multi ? `@${hit.entity_name} @` : `@${hit.entity_name} `
      const nextNote = `${before}${insert}${after}`
      const nextTags = [
        ...tags.filter(
          (t) => !(t.kind === hit.kind && t.entity_id === hit.entity_id),
        ),
        {
          kind: hit.kind as 'person' | 'project',
          entity_id: hit.entity_id,
          entity_name: hit.entity_name,
        },
      ]
      setNote(nextNote)
      setTags(nextTags)
      scheduleSave(nextNote, nextTags)

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
    [mentionRange, note, tags, scheduleSave, runMentionSearch, syncMentionAnchor],
  )

  const removeTag = (tag: BookmarkManualTag) => {
    const nextTags = tags.filter(
      (t) => !(t.kind === tag.kind && t.entity_id === tag.entity_id),
    )
    setTags(nextTags)
    scheduleSave(note, nextTags)
  }

  const onNoteChange = (value: string) => {
    setNote(value)
    scheduleSave(value, tags)
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

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionOpen || mentionHits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setMentionIdx((i) => (i + 1) % mentionHits.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMentionIdx((i) => (i - 1 + mentionHits.length) % mentionHits.length)
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      applyMention(mentionHits[mentionIdx]!, e.ctrlKey || e.metaKey)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMentionOpen(false)
      setMentionHits([])
      setMentionRange(null)
      setMentionAnchor(null)
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${Math.max(88, Math.min(ta.scrollHeight, 200))}px`
    if (mentionOpen) syncMentionAnchor()
  }, [note, open, mentionOpen, syncMentionAnchor])

  const hasContent = Boolean(note.trim() || tags.length > 0)
  const taggedIds = useMemo(
    () => new Set(tags.map((t) => `${t.kind}:${t.entity_id}`)),
    [tags],
  )
  const statusLabel =
    saveState === 'saving'
      ? 'guardando…'
      : saveState === 'error'
        ? 'error'
        : saveState === 'dirty'
          ? '…'
          : null

  return (
    <div className="criba-note-fab" ref={popRef}>
      {open && (
        <div className="criba-note-pop" role="dialog" aria-label="Nota">
          <header className="criba-note-head">
            <h3>Nota</h3>
            {statusLabel && (
              <span className="muted criba-note-status">{statusLabel}</span>
            )}
            <button
              type="button"
              className="criba-note-close"
              aria-label="Cerrar nota"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <div className="criba-note-body">
            <textarea
              ref={taRef}
              className="criba-note-textarea"
              value={note}
              placeholder="Anotá… @ para etiquetar"
              onChange={(e) => onNoteChange(e.target.value)}
              onKeyDown={onKeyDown}
              onScroll={() => {
                if (mentionOpen) syncMentionAnchor()
              }}
              onClick={() => {
                if (mentionOpen) syncMentionAnchor()
              }}
              onBlur={() => {
                if (dirty.current) {
                  if (saveTimer.current) clearTimeout(saveTimer.current)
                  void persist(note, tags)
                }
              }}
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
            <ul className="criba-note-tags">
              {tags.map((tag) => (
                <li key={`${tag.kind}:${tag.entity_id}`}>
                  <span
                    className="criba-note-tag"
                    title={tag.kind === 'person' ? 'Persona' : 'Proyecto'}
                  >
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

          {saveError && <p className="criba-error">{saveError}</p>}
        </div>
      )}

      <button
        type="button"
        className={`criba-note-btn${hasContent ? ' has-content' : ''}${
          open ? ' is-open' : ''
        }`}
        aria-expanded={open}
        aria-label={hasContent ? 'Abrir nota (con contenido)' : 'Abrir nota'}
        onClick={() => setOpen((v) => !v)}
      >
        Nota
        {tags.length > 0 && (
          <span className="criba-note-btn-badge">{tags.length}</span>
        )}
      </button>
    </div>
  )
}
