import { useEffect, useRef, useState } from 'react'
import { api } from '../services/api'
import type { GraphicElement, Notebook } from '../types'

type Tool = 'pen' | 'line' | 'rect' | 'text' | 'eraser'

type Stroke = {
  tool: Tool
  color: string
  width: number
  points: Array<[number, number]>
  text?: string
}

const W = 720
const H = 960

export function DigitalPageEditor({
  notebook,
  slot,
  onBack,
  onSaved,
}: {
  notebook: Notebook
  slot: number
  onBack: () => void
  onSaved: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bgRef = useRef<HTMLCanvasElement | null>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#1a1a1a')
  const [width, setWidth] = useState(2)
  const [title, setTitle] = useState('')
  const [transcription, setTranscription] = useState('')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [draft, setDraft] = useState<Stroke | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const ensureBg = () => {
    if (!bgRef.current) {
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.fillStyle = '#f7f4ef'
        ctx.fillRect(0, 0, W, H)
      }
      bgRef.current = c
    }
    return bgRef.current
  }

  useEffect(() => {
    void api
      .getNotebookPage(notebook.id, slot)
      .then((res) => {
        setTitle(res.page.title || '')
        setTranscription(res.page.transcription_spatial || '')
        const bg = ensureBg()
        const bgCtx = bg.getContext('2d')
        if (!bgCtx) return
        bgCtx.fillStyle = '#f7f4ef'
        bgCtx.fillRect(0, 0, W, H)
        if (res.page.image_path) {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            bgCtx.drawImage(img, 0, 0, W, H)
            redraw(null)
          }
          img.src =
            api.notebookPageImageUrl(notebook.id, slot) + `?t=${Date.now()}`
        } else {
          redraw(null)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook.id, slot])

  const redraw = (extra?: Stroke | null) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const bg = ensureBg()
    ctx.drawImage(bg, 0, 0)
    for (const s of strokes) drawStroke(ctx, s)
    if (extra) drawStroke(ctx, extra)
  }

  useEffect(() => {
    redraw(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokes, draft])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * W
    const y = ((e.clientY - rect.top) / rect.height) * H
    return [x, y]
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = pos(e)
    if (tool === 'text') {
      const text = window.prompt('Texto')
      if (!text) return
      setStrokes((prev) => [
        ...prev,
        { tool: 'text', color, width, points: [p], text },
      ])
      setTranscription((t) => (t ? `${t}\n${text}` : text))
      return
    }
    setDraft({
      tool,
      color: tool === 'eraser' ? '#f7f4ef' : color,
      width: tool === 'eraser' ? Math.max(width * 4, 12) : width,
      points: [p, p],
    })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draft) return
    const p = pos(e)
    setDraft((d) => {
      if (!d) return d
      if (d.tool === 'pen' || d.tool === 'eraser') {
        return { ...d, points: [...d.points, p] }
      }
      return { ...d, points: [d.points[0], p] }
    })
  }

  const onPointerUp = () => {
    if (!draft) return
    setStrokes((prev) => [...prev, draft])
    setDraft(null)
  }

  const strokesToGraphics = (): GraphicElement[] => {
    return strokes
      .filter((s) => s.tool !== 'pen' && s.tool !== 'eraser' && s.tool !== 'text')
      .map((s) => {
        const xs = s.points.map((p) => p[0] / W)
        const ys = s.points.map((p) => p[1] / H)
        const minX = Math.min(...xs)
        const minY = Math.min(...ys)
        const maxX = Math.max(...xs)
        const maxY = Math.max(...ys)
        return {
          type:
            s.tool === 'rect'
              ? 'shape'
              : s.tool === 'line'
                ? 'line'
                : 'drawing',
          bbox: [minX, minY, maxX - minX, maxY - minY] as [
            number,
            number,
            number,
            number,
          ],
          label: s.tool,
          points: s.points.map(([x, y]) => [x / W, y / H] as [number, number]),
        }
      })
  }

  const save = async (andValidate = false) => {
    const canvas = canvasRef.current
    if (!canvas) return
    setBusy(true)
    setError(null)
    setMsg(null)
    try {
      const image_base64 = canvas.toDataURL('image/png')
      await api.saveNotebookCanvas(notebook.id, slot, {
        image_base64,
        title: title || undefined,
        transcription_spatial: transcription,
        graphic_elements: strokesToGraphics(),
        run_vision: false,
      })
      setMsg('Guardado')
      onSaved()
      if (andValidate) {
        /* parent will open validate via onSaved + user navigation */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al guardar')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="nb-section nb-digital">
      <div className="nb-reader-bar">
        <button type="button" className="btn btn-ghost btn-tiny" onClick={onBack}>
          ← Spreads
        </button>
        <div className="nb-reader-title">
          <strong>{notebook.title}</strong>
          <span className="muted">Slot {slot} · lienzo</span>
        </div>
        <div className="nb-reader-actions">
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy}
            onClick={() => {
              setStrokes([])
              setDraft(null)
              const bg = ensureBg()
              const bgCtx = bg.getContext('2d')
              if (bgCtx) {
                bgCtx.fillStyle = '#f7f4ef'
                bgCtx.fillRect(0, 0, W, H)
              }
              redraw(null)
            }}
          >
            Limpiar
          </button>
          <button
            type="button"
            className="btn btn-primary btn-tiny"
            disabled={busy}
            onClick={() => void save()}
          >
            Guardar cara
          </button>
        </div>
      </div>

      {error && <p className="nb-error">{error}</p>}
      {msg && <p className="nb-ok">{msg}</p>}

      <div className="nb-digital-tools">
        {(
          [
            ['pen', 'Lápiz'],
            ['line', 'Línea'],
            ['rect', 'Rectángulo'],
            ['text', 'Texto'],
            ['eraser', 'Goma'],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            className={
              tool === t ? 'btn btn-tiny is-nav-active' : 'btn btn-tiny'
            }
            onClick={() => setTool(t)}
          >
            {label}
          </button>
        ))}
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          title="Color"
        />
        <label className="muted">
          Grosor
          <input
            type="range"
            min={1}
            max={12}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="nb-digital-layout">
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="nb-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="nb-digital-meta">
          <label>
            Título
            <input
              className="nb-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Transcripción / texto
            <textarea
              className="nb-textarea"
              rows={18}
              value={transcription}
              onChange={(e) => setTranscription(e.target.value)}
            />
          </label>
          <p className="muted">
            Al guardar la cara queda lista para aprobar la transcripción (mismo
            flujo que el físico).
          </p>
        </div>
      </div>
    </section>
  )
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  s: Stroke,
): void {
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (s.tool === 'text' && s.text && s.points[0]) {
    ctx.font = `${Math.max(14, s.width * 8)}px Georgia, serif`
    ctx.fillText(s.text, s.points[0][0], s.points[0][1])
    return
  }

  if (s.tool === 'rect' && s.points.length >= 2) {
    const [x0, y0] = s.points[0]
    const [x1, y1] = s.points[s.points.length - 1]
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    return
  }

  if (s.tool === 'line' && s.points.length >= 2) {
    const [x0, y0] = s.points[0]
    const [x1, y1] = s.points[s.points.length - 1]
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    return
  }

  if (s.points.length < 2) return
  ctx.beginPath()
  ctx.moveTo(s.points[0][0], s.points[0][1])
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i][0], s.points[i][1])
  }
  ctx.stroke()
}
