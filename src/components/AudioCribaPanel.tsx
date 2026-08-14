import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import type {
  BookmarkManualTag,
  DiarizationPayload,
  Entry,
  SpeakerAssignment,
} from '../types'
import { TagField } from './TagField'

type Props = {
  refreshKey: number
  onChanged: () => void
}

function keyToWeight(e: KeyboardEvent): number | null {
  const k = e.key
  if (k >= '1' && k <= '9') return Number(k)
  if (k === '0' || k === 'q' || k === 'Q') return 10
  if (k === "'" || k === '.' || k === 'w' || k === 'W') return 11
  if (k === '¡' || k === 'Enter' || k === 'e' || k === 'E') return 12
  return null
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

function parseSpeakerMap(raw: string | null | undefined): SpeakerAssignment[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is SpeakerAssignment =>
        !!s && typeof s === 'object' && Number.isFinite(Number(s.speaker)),
    )
  } catch {
    return []
  }
}

function parseDiarization(raw: string | null | undefined): DiarizationPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DiarizationPayload
    if (!parsed || !Array.isArray(parsed.utterances)) return null
    return parsed
  } catch {
    return null
  }
}

export function AudioCribaPanel({ refreshKey, onChanged }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [idx, setIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState('')
  const [note, setNote] = useState('')
  const [tags, setTags] = useState<BookmarkManualTag[]>([])
  const [speakers, setSpeakers] = useState<SpeakerAssignment[]>([])

  const audioRef = useRef<HTMLAudioElement>(null)
  const loadInFlight = useRef(false)

  const active = entries[idx] ?? null

  const load = useCallback(async () => {
    if (loadInFlight.current) return
    loadInFlight.current = true
    setLoading(true)
    setError(null)
    try {
      const data = await api.getCribaAudios()
      setEntries(data.entries)
      setIdx((prev) => {
        if (data.entries.length === 0) return 0
        if (prev >= data.entries.length) return 0
        return prev
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al cargar criba')
    } finally {
      loadInFlight.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => {
    if (!active) {
      setTranscript('')
      setNote('')
      setTags([])
      setSpeakers([])
      return
    }
    setTranscript(active.content_raw ?? '')
    setNote(active.operator_note ?? '')
    setTags(parseTags(active.manual_tags))
    const mapped = parseSpeakerMap(active.speaker_map)
    const dia = parseDiarization(active.diarization_json)
    if (mapped.length > 0) {
      setSpeakers(mapped)
    } else if (dia?.speakers?.length) {
      setSpeakers(
        dia.speakers.map((speaker) => ({
          speaker,
          person_id: null,
          person_name: null,
        })),
      )
    } else {
      setSpeakers([{ speaker: 0, person_id: null, person_name: null }])
    }
  }, [active?.id])

  const personTags = useMemo(
    () => tags.filter((t) => t.kind === 'person'),
    [tags],
  )

  const vote = useCallback(
    async (weight: number) => {
      if (!active || busy) return
      setBusy(true)
      setError(null)
      try {
        await api.voteAudioCriba(active.id, weight, {
          content_raw: transcript,
          operator_note: note,
          manual_tags: tags,
          speaker_map: speakers,
        })
        onChanged()
        setEntries((prev) => prev.filter((e) => e.id !== active.id))
        setIdx(0)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo votar')
      } finally {
        setBusy(false)
      }
    },
    [active, busy, transcript, note, tags, speakers, onChanged],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (t?.isContentEditable) return
      const w = keyToWeight(e)
      if (w == null) return
      e.preventDefault()
      void vote(w)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [vote])

  function assignSpeaker(speaker: number, tag: BookmarkManualTag | null) {
    setSpeakers((prev) =>
      prev.map((s) =>
        s.speaker === speaker
          ? {
              speaker,
              person_id: tag?.entity_id ?? null,
              person_name: tag?.entity_name ?? null,
            }
          : s,
      ),
    )
  }

  if (loading && entries.length === 0) {
    return <p className="muted empty">Cargando criba de audios…</p>
  }

  if (!active) {
    return (
      <p className="muted empty">
        No hay audios en criba. Subí un lote en Zona franca; tras el STT aparecen acá.
      </p>
    )
  }

  return (
    <div className="audio-criba">
      <div className="audio-criba-head">
        <p className="criba-counter">
          <span className="mono">
            {idx + 1}/{entries.length}
          </span>
          <span className="truncate audio-criba-title">{active.title}</span>
        </p>
        {error && <p className="status-line err">{error}</p>}
      </div>

      <div className="audio-criba-grid">
        <div className="audio-criba-player">
          <audio
            ref={audioRef}
            key={active.id}
            controls
            src={`/api/entries/${encodeURIComponent(active.id)}/media`}
          />
          <div className="audio-criba-keys muted">
            1–9 · 0/q=10 · w=11 · Enter/e=12
          </div>
          <div className="audio-criba-weights">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((w) => (
              <button
                key={w}
                type="button"
                className={`btn btn-tiny audio-w ${w <= 3 ? 'is-slop' : ''}`}
                disabled={busy}
                onClick={() => void vote(w)}
              >
                {w}
              </button>
            ))}
          </div>
        </div>

        <label className="audio-criba-transcript">
          Transcripción
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={14}
            spellCheck
          />
        </label>
      </div>

      <div className="audio-criba-meta">
        <div>
          <p className="blob-composer-label">Voces</p>
          <ul className="audio-speaker-list">
            {speakers.map((s) => (
              <li key={s.speaker}>
                <span className="mono">Speaker {s.speaker}</span>
                <span className="audio-speaker-name">
                  {s.person_name ?? 'sin asignar'}
                </span>
                <button
                  type="button"
                  className="btn btn-tiny"
                  onClick={() => assignSpeaker(s.speaker, null)}
                >
                  —
                </button>
                {personTags.map((tag) => (
                  <button
                    key={tag.entity_id}
                    type="button"
                    className={
                      s.person_id === tag.entity_id
                        ? 'btn btn-tiny is-on'
                        : 'btn btn-tiny'
                    }
                    onClick={() => assignSpeaker(s.speaker, tag)}
                  >
                    @{tag.entity_name}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="blob-composer-label">Tags</p>
          <TagField
            tags={tags}
            note={note}
            disabled={busy}
            onChange={({ tags: nextTags, note: nextNote }) => {
              setTags(nextTags)
              setNote(nextNote)
            }}
          />
        </div>
      </div>
    </div>
  )
}
