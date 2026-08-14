import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../services/api'
import { getClientLogs } from '../lib/clientLogs'

const VIEW_LABELS: Record<string, string> = {
  franca: 'Zona franca',
  aduana: 'Aduana',
  validada: 'Validada',
  entidades: 'Entidades',
  quantomos: 'Quántomos',
  grafo: 'Grafo',
  criba: 'Criba',
  biblioteca: 'Biblioteca',
  chats: 'Chats',
  respaldo: 'Respaldo',
}

interface Props {
  view: string
}

type Preview = { id: string; file: File; url: string }

function collectPageContext(view: string): Record<string, unknown> {
  const main = document.querySelector('main')
  const heading = main?.querySelector('h2, h1')?.textContent?.trim() ?? null
  const activeNav = document
    .querySelector('.brand-nav .is-nav-active')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim()
  const activeTab = document
    .querySelector('[role="tab"][aria-selected="true"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim()
  const focused = document.activeElement
  let focusHint: string | null = null
  if (focused instanceof HTMLElement && focused !== document.body) {
    const label =
      focused.getAttribute('aria-label') ||
      focused.getAttribute('placeholder') ||
      focused.textContent?.trim().slice(0, 80)
    focusHint = `${focused.tagName.toLowerCase()}${focused.className ? '.' + String(focused.className).split(' ')[0] : ''}${label ? ` — ${label}` : ''}`
  }

  return {
    view,
    view_label: VIEW_LABELS[view] ?? view,
    heading,
    nav: activeNav,
    tab: activeTab ?? null,
    href: window.location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    user_agent: navigator.userAgent,
    focus: focusHint,
  }
}

export function FeedbackWidget({ view }: Props) {
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [previews, setPreviews] = useState<Preview[]>([])
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [whereDetail, setWhereDetail] = useState('')
  const textRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const contextRef = useRef<Record<string, unknown>>({})

  const close = useCallback(() => {
    setOpen(false)
    setError(null)
  }, [])

  const openPanel = useCallback(() => {
    const ctx = collectPageContext(view)
    contextRef.current = ctx
    const bits = [VIEW_LABELS[view] ?? view]
    if (typeof ctx.tab === 'string' && ctx.tab) bits.push(ctx.tab)
    if (typeof ctx.heading === 'string' && ctx.heading) bits.push(ctx.heading)
    setWhereDetail(bits.join(' · '))
    setOpen(true)
    setStatus(null)
    setError(null)
    window.setTimeout(() => textRef.current?.focus(), 40)
  }, [view])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.repeat) return
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        const typing =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        if (typing) return
      }
      e.preventDefault()
      e.stopPropagation()
      openPanel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close, openPanel])

  useEffect(() => {
    return () => {
      for (const p of previews) URL.revokeObjectURL(p.url)
    }
  }, [previews])

  const addFiles = useCallback((files: FileList | File[]) => {
    const next: Preview[] = []
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        file,
        url: URL.createObjectURL(file),
      })
    }
    if (next.length) setPreviews((prev) => [...prev, ...next].slice(0, 12))
  }, [])

  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.files
      if (!items?.length) return
      const images = Array.from(items).filter((f) => f.type.startsWith('image/'))
      if (images.length) {
        e.preventDefault()
        addFiles(images)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [open, addFiles])

  function removePreview(id: string) {
    setPreviews((prev) => {
      const hit = prev.find((p) => p.id === id)
      if (hit) URL.revokeObjectURL(hit.url)
      return prev.filter((p) => p.id !== id)
    })
  }

  async function submit() {
    if (sending) return
    if (!body.trim() && previews.length === 0) {
      setError('Escribí algo o adjuntá una imagen')
      return
    }
    setSending(true)
    setError(null)
    setStatus(null)
    try {
      const context = {
        ...contextRef.current,
        view,
        view_label: VIEW_LABELS[view] ?? view,
      }
      const logs = getClientLogs()
      const res = await api.sendFeedback({
        body: body.trim(),
        viewId: view,
        context,
        logs,
        images: previews.map((p) => p.file),
      })
      for (const p of previews) URL.revokeObjectURL(p.url)
      setPreviews([])
      setBody('')
      setStatus(`Guardado en ${res.folder}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar')
    } finally {
      setSending(false)
    }
  }

  const where = VIEW_LABELS[view] ?? view

  return (
    <>
      <button
        type="button"
        className="feedback-fab"
        aria-label="Abrir feedback"
        title="Feedback (Esc)"
        onClick={() => (open ? close() : openPanel())}
      >
        !
      </button>

      {open && (
        <div className="feedback-scrim" onClick={close}>
          <aside
            className="feedback-panel"
            role="dialog"
            aria-labelledby="feedback-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="feedback-head">
              <div>
                <h2 id="feedback-title">Feedback</h2>
                <p className="muted mono feedback-where">
                  Estás en {whereDetail || where}
                </p>
              </div>
              <button type="button" className="btn btn-tiny" onClick={close}>
                Cerrar
              </button>
            </header>

            <textarea
              ref={textRef}
              className="feedback-text"
              rows={6}
              placeholder="Qué viste, qué falló, qué querés que recuerde…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />

            <div className="feedback-attach">
              <button
                type="button"
                className="btn btn-tiny"
                onClick={() => fileRef.current?.click()}
              >
                Adjuntar imágenes
              </button>
              <span className="muted">o pegá con Ctrl+V</span>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>

            {previews.length > 0 && (
              <ul className="feedback-thumbs">
                {previews.map((p) => (
                  <li key={p.id}>
                    <img src={p.url} alt="" />
                    <button
                      type="button"
                      className="feedback-thumb-x"
                      aria-label="Quitar imagen"
                      onClick={() => removePreview(p.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error && <p className="status-line err">{error}</p>}
            {status && <p className="status-line ok">{status}</p>}

            <footer className="feedback-foot">
              <span className="muted mono">Esc cierra · Ctrl+Enter envía</span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={sending}
                onClick={() => void submit()}
              >
                {sending ? 'Guardando…' : 'Enviar'}
              </button>
            </footer>
          </aside>
        </div>
      )}
    </>
  )
}
