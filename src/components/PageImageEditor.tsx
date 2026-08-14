import { useEffect, useRef, useState } from 'react'

type BBox = [number, number, number, number]

export function PageImageEditor({
  imageUrl,
  initialCrop,
  onApply,
  onCancel,
  busy,
}: {
  imageUrl: string
  initialCrop?: BBox | null
  onApply: (payload: {
    rotate: 0 | 90 | 180 | 270
    crop: BBox
    image_base64: string
  }) => void
  onCancel: () => void
  busy?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0)
  const [crop, setCrop] = useState<BBox>(initialCrop ?? [0.05, 0.05, 0.9, 0.9])
  const [drag, setDrag] = useState<{
    mode: 'move' | 'br'
    ox: number
    oy: number
    start: BBox
  } | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      setReady(true)
    }
    img.src = imageUrl.includes('?')
      ? `${imageUrl}&t=${Date.now()}`
      : `${imageUrl}?t=${Date.now()}`
  }, [imageUrl])

  useEffect(() => {
    if (initialCrop) setCrop(initialCrop)
  }, [initialCrop])

  const dims = () => {
    const img = imgRef.current
    if (!img) return { w: 1, h: 1 }
    if (rotate === 90 || rotate === 270) {
      return { w: img.height, h: img.width }
    }
    return { w: img.width, h: img.height }
  }

  const paint = () => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img) return
    const { w, h } = dims()
    const maxW = 520
    const scale = Math.min(1, maxW / w)
    canvas.width = Math.floor(w * scale)
    canvas.height = Math.floor(h * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((rotate * Math.PI) / 180)
    const dw = (rotate === 90 || rotate === 270 ? h : w) * scale
    const dh = (rotate === 90 || rotate === 270 ? w : h) * scale
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
    ctx.restore()

    const [cx, cy, cw, ch] = crop
    const rx = cx * canvas.width
    const ry = cy * canvas.height
    const rw = cw * canvas.width
    const rh = ch * canvas.height

    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.clearRect(rx, ry, rw, rh)
    // redraw crop region clean
    ctx.save()
    ctx.beginPath()
    ctx.rect(rx, ry, rw, rh)
    ctx.clip()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((rotate * Math.PI) / 180)
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
    ctx.restore()

    ctx.strokeStyle = '#c4a574'
    ctx.lineWidth = 2
    ctx.strokeRect(rx, ry, rw, rh)
    ctx.fillStyle = '#c4a574'
    ctx.fillRect(rx + rw - 8, ry + rh - 8, 8, 8)
  }

  useEffect(() => {
    if (ready) paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, rotate, crop])

  const toNorm = (
    e: React.PointerEvent<HTMLCanvasElement>,
  ): [number, number] => {
    const rect = e.currentTarget.getBoundingClientRect()
    return [
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    ]
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const [x, y] = toNorm(e)
    const [cx, cy, cw, ch] = crop
    const nearBr = x > cx + cw - 0.04 && y > cy + ch - 0.04
    setDrag({
      mode: nearBr ? 'br' : 'move',
      ox: x,
      oy: y,
      start: crop,
    })
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag) return
    const [x, y] = toNorm(e)
    const dx = x - drag.ox
    const dy = y - drag.oy
    const [sx, sy, sw, sh] = drag.start
    if (drag.mode === 'move') {
      setCrop([
        Math.min(1 - sw, Math.max(0, sx + dx)),
        Math.min(1 - sh, Math.max(0, sy + dy)),
        sw,
        sh,
      ])
    } else {
      setCrop([
        sx,
        sy,
        Math.min(1 - sx, Math.max(0.05, sw + dx)),
        Math.min(1 - sy, Math.max(0.05, sh + dy)),
      ])
    }
  }

  const onPointerUp = () => setDrag(null)

  const exportCropped = (): string => {
    const img = imgRef.current
    if (!img) return ''
    const { w, h } = dims()
    const rot = document.createElement('canvas')
    rot.width = w
    rot.height = h
    const rctx = rot.getContext('2d')!
    rctx.translate(w / 2, h / 2)
    rctx.rotate((rotate * Math.PI) / 180)
    if (rotate === 90 || rotate === 270) {
      rctx.drawImage(img, -h / 2, -w / 2)
    } else {
      rctx.drawImage(img, -w / 2, -h / 2)
    }
    const [cx, cy, cw, ch] = crop
    const sx = Math.floor(cx * w)
    const sy = Math.floor(cy * h)
    const sw = Math.max(1, Math.floor(cw * w))
    const sh = Math.max(1, Math.floor(ch * h))
    const out = document.createElement('canvas')
    out.width = sw
    out.height = sh
    const octx = out.getContext('2d')!
    octx.fillStyle = '#fff'
    octx.fillRect(0, 0, sw, sh)
    octx.drawImage(rot, sx, sy, sw, sh, 0, 0, sw, sh)
    return out.toDataURL('image/png')
  }

  return (
    <div className="nb-image-editor">
      <div className="nb-digital-tools">
        <button
          type="button"
          className="btn btn-tiny"
          disabled={busy}
          onClick={() =>
            setRotate((r) => ((r + 270) % 360) as 0 | 90 | 180 | 270)
          }
        >
          ⟲ 90°
        </button>
        <button
          type="button"
          className="btn btn-tiny"
          disabled={busy}
          onClick={() =>
            setRotate((r) => ((r + 90) % 360) as 0 | 90 | 180 | 270)
          }
        >
          ⟳ 90°
        </button>
        <button
          type="button"
          className="btn btn-tiny"
          disabled={busy}
          onClick={() => setCrop([0.02, 0.02, 0.96, 0.96])}
        >
          Reset crop
        </button>
        {initialCrop && (
          <button
            type="button"
            className="btn btn-tiny"
            disabled={busy}
            onClick={() => setCrop(initialCrop)}
          >
            Usar bbox visión
          </button>
        )}
      </div>
      <canvas
        ref={canvasRef}
        className="nb-crop-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <p className="muted" style={{ fontSize: '0.78rem' }}>
        Arrastrá el recuadro; esquina inferior derecha para redimensionar. La
        hoja debería ocupar casi todo el encuadre.
      </p>
      <div className="nb-reader-actions">
        <button
          type="button"
          className="btn btn-tiny"
          disabled={busy}
          onClick={onCancel}
        >
          Cancelar
        </button>
        <button
          type="button"
          className="btn btn-primary btn-tiny"
          disabled={busy || !ready}
          onClick={() =>
            onApply({
              rotate,
              crop,
              image_base64: exportCropped(),
            })
          }
        >
          Aplicar y re-procesar
        </button>
      </div>
    </div>
  )
}
