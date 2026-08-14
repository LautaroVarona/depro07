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
import type {
  BlobTag,
  GraphicElement,
  Notebook,
  NotebookPage,
  NotebookPageVisionMeta,
} from '../types'
import { MentionMenu, type MentionMenuHit } from './MentionMenu'
import { getTextareaCaretRect } from '../lib/textareaCaret'
import { PageImageEditor } from './PageImageEditor'

const TOTAL_FACES = 160
const EXPLANATION_SEPARATOR = '____________________'

function splitExplanation(
  full: string | null | undefined,
  userStored?: string | null,
): { user: string; ai: string } {
  const storedUser = (userStored || '').trim()
  const text = (full || '').trim()
  if (storedUser) {
    const idx = text.indexOf(EXPLANATION_SEPARATOR)
    if (idx >= 0) {
      return {
        user: storedUser,
        ai: text
          .slice(idx + EXPLANATION_SEPARATOR.length)
          .replace(/^\n+/, '')
          .trim(),
      }
    }
    if (text === storedUser) return { user: storedUser, ai: '' }
    if (text.startsWith(storedUser)) {
      return {
        user: storedUser,
        ai: text.slice(storedUser.length).replace(/^\n+/, '').trim(),
      }
    }
    return { user: storedUser, ai: '' }
  }
  const wrapped = `\n${EXPLANATION_SEPARATOR}\n`
  const idx = text.indexOf(wrapped)
  if (idx >= 0) {
    return {
      user: text.slice(0, idx).trim(),
      ai: text.slice(idx + wrapped.length).trim(),
    }
  }
  const idx2 = text.indexOf(EXPLANATION_SEPARATOR)
  if (idx2 >= 0) {
    return {
      user: text.slice(0, idx2).trim(),
      ai: text
        .slice(idx2 + EXPLANATION_SEPARATOR.length)
        .replace(/^\n+/, '')
        .trim(),
    }
  }
  return { user: '', ai: text }
}

type Pane = 'transcripcion' | 'explicacion' | 'json' | 'entidades'

function parseMeta(raw: string | null | undefined): NotebookPageVisionMeta | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as NotebookPageVisionMeta
  } catch {
    return null
  }
}

function parseTags(raw: string | null | undefined): BlobTag[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is BlobTag =>
        !!t &&
        typeof t === 'object' &&
        (t.kind === 'person' || t.kind === 'project' || t.kind === 'agrupacion') &&
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

export function PageValidationPanel({
  notebook,
  slot,
  onBack,
  onChanged,
  onSlotChange,
}: {
  notebook: Notebook
  slot: number
  onBack: () => void
  onChanged: () => void
  onSlotChange?: (slot: number) => void
}) {
  const [page, setPage] = useState<NotebookPage | null>(null)
  const [label, setLabel] = useState('')
  const [title, setTitle] = useState('')
  const [transcription, setTranscription] = useState('')
  const [explanation, setExplanation] = useState('')
  const [explanationAi, setExplanationAi] = useState('')
  const [graphicsText, setGraphicsText] = useState('[]')
  const [entityNote, setEntityNote] = useState('')
  const [tags, setTags] = useState<BlobTag[]>([])
  const [numero, setNumero] = useState(1)
  const [posicion, setPosicion] = useState('Izquierda')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [editingImage, setEditingImage] = useState(false)
  const [imgTick, setImgTick] = useState(0)
  const [pane, setPane] = useState<Pane>('transcripcion')

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

  const meta = useMemo(
    () => parseMeta(page?.vision_meta),
    [page?.vision_meta],
  )

  const taggedIds = useMemo(
    () => new Set(tags.map((t) => t.entity_id)),
    [tags],
  )

  const load = async (targetSlot = slot) => {
    const res = await api.getNotebookPage(notebook.id, targetSlot)
    setPage(res.page)
    setLabel(res.label)
    setTitle(res.page.title || '')
    setTranscription(res.page.transcription_spatial || '')
    const split = splitExplanation(
      res.page.explanation,
      res.page.explanation_user,
    )
    setExplanation(split.user)
    setExplanationAi(split.ai)
    try {
      const parsed = JSON.parse(res.page.graphic_elements || '[]')
      setGraphicsText(JSON.stringify(parsed, null, 2))
    } catch {
      setGraphicsText(res.page.graphic_elements || '[]')
    }
    const loadedTags = parseTags(res.page.mentioned_entities)
    setTags(loadedTags)
    setEntityNote(
      loadedTags.length
        ? loadedTags.map((t) => `@${t.entity_name}`).join(' ') + ' '
        : '',
    )
    setNumero(res.page.numero_logico)
    setPosicion(res.page.posicion_visual)
    setEditingImage(false)
    setMentionOpen(false)
    setImgTick((t) => t + 1)
  }

  useEffect(() => {
    setError(null)
    setMsg(null)
    setPane('transcripcion')
    void load(slot).catch((e) =>
      setError(e instanceof Error ? e.message : 'Error'),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook.id, slot])

  useEffect(() => {
    if (!page || page.status !== 'PendienteVision') return
    const id = window.setInterval(() => {
      void load(slot).catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.status, notebook.id, slot])

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      searchAbort.current?.abort()
    }
  }, [])

  const goSlot = (next: number) => {
    if (next < 0 || next >= TOTAL_FACES) return
    const from = slot
    const body = patchBody()
    onSlotChange?.(next)
    void api.patchNotebookPage(notebook.id, from, body).catch(() => undefined)
  }

  const patchBody = () => {
    let graphics: GraphicElement[] | string = graphicsText
    try {
      graphics = JSON.parse(graphicsText) as GraphicElement[]
    } catch {
      /* keep string */
    }
    return {
      title,
      transcription_spatial: transcription,
      graphic_elements: graphics,
      numero_logico: numero,
      posicion_visual: posicion,
      explanation,
      mentioned_entities: tags,
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const { page: updated } = await api.patchNotebookPage(
        notebook.id,
        slot,
        patchBody(),
      )
      setPage(updated)
      const split = splitExplanation(
        updated.explanation,
        updated.explanation_user,
      )
      setExplanation(split.user)
      setExplanationAi(split.ai)
      setMsg('Guardado')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar')
    } finally {
      setBusy(false)
    }
  }

  const reprocess = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.reprocessNotebookPageVision(notebook.id, slot)
      setMsg('Visión en cola')
      onChanged()
      await load(slot)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error visión')
    } finally {
      setBusy(false)
    }
  }

  const approve = async () => {
    const savedSlot = slot
    setError(null)
    setMsg(null)
    setBusy(true)
    try {
      await api.patchNotebookPage(notebook.id, savedSlot, patchBody())
      const res = await api.approveNotebookTranscription(
        notebook.id,
        savedSlot,
      )
      setPage(res.page)
      setMsg('Transcripción aprobada')
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al aprobar')
    } finally {
      setBusy(false)
    }
  }

  const applyPageBBox = async () => {
    if (!meta?.page_bbox) return
    setBusy(true)
    setError(null)
    try {
      const rotate = (meta.orientation_hint ?? 0) as 0 | 90 | 180 | 270
      await api.transformNotebookPageImage(notebook.id, slot, {
        rotate,
        crop: meta.page_bbox,
        reprocess: true,
      })
      setMsg('Recorte a hoja aplicado · visión en cola')
      setEditingImage(false)
      onChanged()
      await load(slot)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al recortar')
    } finally {
      setBusy(false)
    }
  }

  const splitSpread = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api.splitNotebookSpread(notebook.id, slot)
      setMsg(
        `Spread separado → slots ${res.left_slot} (izq) y ${res.right_slot} (der)`,
      )
      onChanged()
      await load(slot)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al separar spread')
    } finally {
      setBusy(false)
    }
  }

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
              (h): h is typeof h & { kind: BlobTag['kind'] } =>
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
      const before = entityNote.slice(0, mentionRange.start)
      const after = entityNote.slice(mentionRange.end)
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
      setEntityNote(nextText)
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
    [mentionRange, entityNote, tags, runMentionSearch, syncMentionAnchor],
  )

  const onEntityChange = (value: string) => {
    setEntityNote(value)
    const ta = taRef.current
    const caret = ta?.selectionStart ?? value.length
    const mq = mentionQueryAt(value, caret)
    if (!mq) {
      setMentionOpen(false)
      setMentionRange(null)
      return
    }
    setMentionRange({ start: mq.start, end: caret })
    setMentionOpen(true)
    syncMentionAnchor(caret)
    runMentionSearch(mq.query)
  }

  const onEntityKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
      setMentionOpen(false)
    }
  }

  useLayoutEffect(() => {
    if (pane === 'entidades' && mentionOpen) syncMentionAnchor()
  }, [entityNote, pane, mentionOpen, syncMentionAnchor])

  const paneValue =
    pane === 'transcripcion'
      ? transcription
      : pane === 'explicacion'
        ? explanation
        : pane === 'json'
          ? graphicsText
          : entityNote

  const setPaneValue = (value: string) => {
    if (pane === 'transcripcion') setTranscription(value)
    else if (pane === 'explicacion') setExplanation(value)
    else if (pane === 'json') setGraphicsText(value)
    else onEntityChange(value)
  }

  const panePlaceholder =
    pane === 'explicacion'
      ? 'Tu explicación (opcional). La IA se escribe debajo después de «Generar explicaciones».'
      : pane === 'entidades'
        ? 'Mencioná con @ personas, proyectos o grupos de esta hoja.'
        : pane === 'json'
          ? '[]'
          : ''

  if (!page) {
    return (
      <section className="nb-section nb-validate is-fit">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
          ← Volver
        </button>
        <p className="muted">{error || 'Cargando página…'}</p>
      </section>
    )
  }

  const imageUrl = `${api.notebookPageImageUrl(notebook.id, slot)}?v=${imgTick}`

  return (
    <section className="nb-section nb-validate is-fit">
      <div className="nb-reader-bar nb-validate-top">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
          ← Spreads
        </button>
        <div className="nb-validate-nav">
          <button
            type="button"
            className="btn btn-tiny"
            disabled={slot <= 0}
            onClick={() => goSlot(slot - 1)}
          >
            ← Anterior
          </button>
          <span className="nb-validate-slot-label">
            {label}
            <span className="muted"> · {slot + 1}/{TOTAL_FACES}</span>
            {page.status === 'Validada' ? (
              <span className="nb-ok"> · aprobada</span>
            ) : page.status === 'Procesada' ? (
              <span className="nb-ok"> · en corpus</span>
            ) : null}
          </span>
          <button
            type="button"
            className="btn btn-tiny"
            disabled={slot >= TOTAL_FACES - 1}
            onClick={() => goSlot(slot + 1)}
          >
            Siguiente →
          </button>
        </div>
        <div className="nb-reader-actions">
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy || !page.image_path}
            onClick={() => setEditingImage((v) => !v)}
          >
            {editingImage ? 'Cerrar editor' : 'Rotar / Recortar'}
          </button>
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy || !page.image_path}
            onClick={() => void reprocess()}
          >
            Re-visión
          </button>
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy}
            onClick={() => void save()}
          >
            Guardar
          </button>
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={busy || page.status === 'Procesada'}
            onClick={() => void approve()}
          >
            {page.status === 'Validada' || page.status === 'Procesada'
              ? 'Transcripción aprobada'
              : 'Aprobar transcripción'}
          </button>
        </div>
      </div>

      {(error || msg || meta?.error) && (
        <div className="nb-validate-flash">
          {error && <span className="nb-error">{error}</span>}
          {meta?.error && !error && (
            <span className="nb-error">Visión: {meta.error}</span>
          )}
          {msg && <span className="nb-ok">{msg}</span>}
        </div>
      )}

      <div className="nb-validate-split is-fit">
        <div className="nb-validate-image">
          {editingImage && page.image_path ? (
            <PageImageEditor
              imageUrl={imageUrl}
              initialCrop={meta?.page_bbox ?? null}
              busy={busy}
              onCancel={() => setEditingImage(false)}
              onApply={async ({ image_base64 }) => {
                setBusy(true)
                setError(null)
                try {
                  await api.replaceNotebookPageImage(
                    notebook.id,
                    slot,
                    image_base64,
                    true,
                  )
                  setMsg('Imagen actualizada · visión en cola')
                  setEditingImage(false)
                  onChanged()
                  await load(slot)
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : 'Error al guardar imagen',
                  )
                } finally {
                  setBusy(false)
                }
              }}
            />
          ) : page.image_path ? (
            <img src={imageUrl} alt={label} />
          ) : (
            <div className="nb-face-empty">Sin imagen</div>
          )}
        </div>

        <div className="nb-validate-form is-fit">
          <div className="nb-form-row nb-form-title-row">
            <label className="nb-grow">
              Título
              <input
                className="nb-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Nº
              <input
                className="nb-input nb-input-num"
                type="number"
                min={0}
                max={80}
                value={numero}
                onChange={(e) => setNumero(Number(e.target.value))}
              />
            </label>
            <label>
              Posición
              <select
                className="nb-input"
                value={posicion === 'ImpactoTapa' ? 'Tapa' : posicion}
                onChange={(e) => setPosicion(e.target.value)}
              >
                <option value="Tapa">Tapa</option>
                <option value="Suelta">Página suelta</option>
                <option value="Izquierda">Izquierda</option>
                <option value="Derecha">Derecha</option>
                <option value="Contratapa">Contratapa</option>
              </select>
            </label>
          </div>

          <div className="nb-pane-toggles" role="tablist">
            {(
              [
                ['transcripcion', 'Transcripción'],
                ['explicacion', 'Explicación'],
                ['json', 'JSON'],
                ['entidades', tags.length ? `Entidades (${tags.length})` : 'Entidades'],
              ] as const
            ).map(([id, labelText]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={pane === id}
                className={`nb-pane-toggle${pane === id ? ' is-active' : ''}`}
                onClick={() => {
                  setPane(id)
                  setMentionOpen(false)
                }}
              >
                {labelText}
              </button>
            ))}
          </div>

          <label className="nb-grow-area nb-pane-field">
            <span className="sr-only">
              {pane === 'transcripcion'
                ? 'Transcripción espacial'
                : pane === 'explicacion'
                  ? 'Explicación'
                  : pane === 'json'
                    ? 'Elementos JSON'
                    : 'Entidades'}
            </span>
            <textarea
              ref={pane === 'entidades' ? taRef : undefined}
              className={`nb-textarea${pane === 'json' ? ' nb-mono' : ''}${pane === 'explicacion' && explanationAi ? ' is-user-explain' : ''}`}
              value={paneValue}
              onChange={(e) => setPaneValue(e.target.value)}
              onKeyDown={pane === 'entidades' ? onEntityKeyDown : undefined}
              onScroll={() => {
                if (pane === 'entidades' && mentionOpen) syncMentionAnchor()
              }}
              onClick={() => {
                if (pane === 'entidades' && mentionOpen) syncMentionAnchor()
              }}
              placeholder={panePlaceholder}
              spellCheck={pane !== 'json'}
            />
            {pane === 'entidades' && (
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
            )}
          </label>
          {pane === 'explicacion' && explanationAi ? (
            <div className="nb-explain-ai">
              <p className="muted nb-explain-sep">{EXPLANATION_SEPARATOR}</p>
              <textarea
                className="nb-textarea is-ai-explain"
                value={explanationAi}
                readOnly
                spellCheck={false}
              />
            </div>
          ) : null}

          {pane === 'entidades' && (
            <div className="nb-entity-pane-extra">
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
                          onClick={() =>
                            setTags((prev) =>
                              prev.filter(
                                (t) =>
                                  !(
                                    t.kind === tag.kind &&
                                    t.entity_id === tag.entity_id
                                  ),
                              ),
                            )
                          }
                        >
                          ×
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="muted nb-entity-hint">
                @ abre el corpus. Al enviar el cuaderno al corpus, esas menciones
                se vinculan a la hoja y el NER las prioriza.
              </p>
            </div>
          )}

          <div className="nb-validate-foot">
            <div className="nb-meta-hover">
              <button type="button" className="nb-meta-trigger">
                Meta visión
                {meta ? ` · ${meta.layout}` : ' · —'}
              </button>
              <div className="nb-meta-popover">
                {meta ? (
                  <>
                    <p>
                      <strong>layout:</strong> {meta.layout}
                      {meta.orientation_hint
                        ? ` · rotación ${meta.orientation_hint}°`
                        : ''}
                    </p>
                    {meta.notes && <p>{meta.notes}</p>}
                    <div className="nb-reader-actions">
                      {meta.page_bbox && (
                        <button
                          type="button"
                          className="btn btn-tiny"
                          disabled={busy}
                          onClick={() => void applyPageBBox()}
                        >
                          Ajustar a hoja
                        </button>
                      )}
                      {meta.layout === 'spread' && meta.spread && (
                        <button
                          type="button"
                          className="btn btn-tiny btn-primary"
                          disabled={busy}
                          onClick={() => void splitSpread()}
                        >
                          Separar Izq/Der
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted">Sin meta todavía (re-visión).</p>
                )}
              </div>
            </div>
            <span className="muted">
              {page.status}
              {page.entry_id ? ` · ${page.entry_id.slice(0, 8)}` : ''}
            </span>
          </div>
        </div>
      </div>
    </section>
  )
}
