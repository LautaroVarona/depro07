import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { api } from '../services/api'
import type { BookmarkManualTag } from '../types'
import { MentionMenu, type MentionMenuHit } from './MentionMenu'
import { getTextareaCaretRect } from '../lib/textareaCaret'

type Props = {
  tags: BookmarkManualTag[]
  note: string
  onChange: (next: { tags: BookmarkManualTag[]; note: string }) => void
  placeholder?: string
  disabled?: boolean
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

export function TagField({
  tags,
  note,
  onChange,
  placeholder = '@ etiquetá perfiles. Texto libre opcional.',
  disabled,
}: Props) {
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

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchAbort.current?.abort()
    }
  }, [])

  const taggedIds = useMemo(
    () => new Set(tags.map((t) => `${t.kind}:${t.entity_id}`)),
    [tags],
  )

  const syncMentionAnchor = useCallback((offset?: number) => {
    const ta = taRef.current
    if (!ta) return
    setMentionAnchor(getTextareaCaretRect(ta, offset ?? ta.selectionStart))
  }, [])

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
        } catch {
          if (!ac.signal.aborted) setMentionHits([])
        } finally {
          if (!ac.signal.aborted) setMentionBusy(false)
        }
      })()
    }, 150)
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
          kind: hit.kind === 'project' ? 'project' : 'person',
          entity_id: hit.entity_id,
          entity_name: hit.entity_name,
        } satisfies BookmarkManualTag,
      ]
      onChange({ tags: nextTags, note: nextNote })
      setMentionOpen(false)
      setMentionHits([])
      setMentionRange(null)
      requestAnimationFrame(() => {
        const pos = before.length + insert.length
        ta.focus()
        ta.setSelectionRange(pos, pos)
        if (multi) {
          const q = mentionQueryAt(nextNote, pos)
          if (q) {
            setMentionOpen(true)
            setMentionRange({ start: q.start, end: pos })
            syncMentionAnchor(pos)
            runMentionSearch(q.query)
          }
        }
      })
    },
    [mentionRange, note, tags, onChange, runMentionSearch, syncMentionAnchor],
  )

  function onTextChange(value: string) {
    onChange({ tags, note: value })
    const ta = taRef.current
    const caret = ta?.selectionStart ?? value.length
    const q = mentionQueryAt(value, caret)
    if (!q) {
      setMentionOpen(false)
      setMentionHits([])
      setMentionRange(null)
      return
    }
    setMentionOpen(true)
    setMentionRange({ start: q.start, end: caret })
    syncMentionAnchor(caret)
    runMentionSearch(q.query)
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionOpen) return
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
        setMentionIdx((i) => (i - 1 + mentionHits.length) % mentionHits.length)
      }
      return
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && mentionHits.length > 0) {
      e.preventDefault()
      applyMention(mentionHits[mentionIdx]!, e.ctrlKey || e.metaKey)
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMentionOpen(false)
    }
  }

  function removeTag(tag: BookmarkManualTag) {
    onChange({
      note,
      tags: tags.filter(
        (t) => !(t.kind === tag.kind && t.entity_id === tag.entity_id),
      ),
    })
  }

  return (
    <div className="tag-field">
      <textarea
        ref={taRef}
        className="tag-field-ta"
        value={note}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        onChange={(e) => onTextChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={() => {
          if (mentionOpen) syncMentionAnchor()
        }}
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
      {tags.length > 0 && (
        <ul className="criba-note-tags">
          {tags.map((tag) => (
            <li key={`${tag.kind}:${tag.entity_id}`}>
              <span className="criba-note-tag">
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
    </div>
  )
}
