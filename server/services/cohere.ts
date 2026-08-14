import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type {
  AgrupacionGeneratedMeta,
  BookmarkCategory,
  BookmarkExtraction,
  ChatExtraction,
  ChatTipo,
  CohereExtraction,
  OcrFrameResult,
} from '../types.js'
import { refinePersonKind } from './nerGuards.js'
import { clampTitleWords } from './titleUtils.js'

function env(key: string, fallback = ''): string {
  return process.env[key]?.replace(/^["']|["']$/g, '') ?? fallback
}

export function isCohereQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /Trial key/i.test(msg) ||
    /1000 API calls/i.test(msg) ||
    /rate limits/i.test(msg) && /Trial/i.test(msg)
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const require = createRequire(import.meta.url)

async function encodeImageForVision(absPath: string): Promise<{
  dataUrl: string
  bytes: number
  width: number
  height: number
}> {
  try {
    const { createCanvas, loadImage } =
      require('@napi-rs/canvas') as typeof import('@napi-rs/canvas')
    const img = await loadImage(absPath)
    const maxEdge = 1600
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height, 1))
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(img, 0, 0, width, height)
    const canvasBuf = canvas as unknown as {
      toBuffer: (mime: string, quality?: number) => Buffer
    }
    let quality = 0.84
    let buf = canvasBuf.toBuffer('image/jpeg', quality)
    while (buf.length > 3_500_000 && quality > 0.5) {
      quality -= 0.12
      buf = canvasBuf.toBuffer('image/jpeg', quality)
    }
    return {
      dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`,
      bytes: buf.length,
      width,
      height,
    }
  } catch (err) {
    const raw = fs.readFileSync(absPath)
    const ext = absPath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
    console.warn(
      '[cohere/notebook-vision] no se pudo reescalar, se manda original:',
      err,
    )
    return {
      dataUrl: `data:image/${ext};base64,${raw.toString('base64')}`,
      bytes: raw.length,
      width: 0,
      height: 0,
    }
  }
}

function chatTextFromCohere(data: unknown): string {
  const d = data as {
    message?: { content?: unknown }
    text?: string
  }
  const content = d.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c) {
          return String((c as { text?: string }).text ?? '')
        }
        return ''
      })
      .join('')
  }
  return d.text || ''
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const tryParse = (s: string) => JSON.parse(s) as Record<string, unknown>
  try {
    return tryParse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return tryParse(cleaned.slice(start, end + 1))
    }
    throw new Error(
      `Visión no devolvió JSON (${cleaned.slice(0, 220) || 'vacío'})`,
    )
  }
}

type ExtractOpts = {
  fallback?: 'mock' | 'none'
  maxQuantomos?: number
  humanWeight?: number
  slop?: boolean
  speakerContext?: string
  tagsContext?: string
  operatorNote?: string
}

function buildAudioSystemPrompt(opts: ExtractOpts): string {
  const maxQ = Math.max(1, opts.maxQuantomos ?? 6)
  const weight = opts.humanWeight ?? 7
  const slopRule = opts.slop
    ? `- Este audio es SLOP (voto 1–3). Extraé 1 cuántomo fiel al transcript. Todas las entidades person nuevas van con kind "ruido" (vincular a Ruido, no crear perfiles).`
    : `- kind (person): fisica | juridica | ficticia | abstracta | ruido.`
  return `Eres el extractor hermético de Deprocast. Recibes un transcript en español de una nota de voz/caminata.
Devuelve ÚNICAMENTE un JSON válido (sin markdown) con esta forma exacta:
{
  "suggested_title": string,
  "quantomos": [
    { "title": string, "content": string, "universe": string }
  ],
  "actions": [
    { "task_text": string, "tag": string }
  ],
  "entities": [
    {
      "name": string,
      "type": "person" | "project",
      "kind": "fisica" | "juridica" | "ficticia" | "abstracta" | "ruido" (solo si type=person),
      "category": string (solo si type=project),
      "status": "activo" | "pausado" | "cerrado" | "emergente" (solo si type=project),
      "tactical_focus": string (solo si type=project, opcional)
    }
  ]
}
Reglas:
- suggested_title = nombre corto del audio, entre 3 y 5 palabras, en español, sin comillas ni puntuación final.
- quantomos = ideas atómicas densas REALES del transcript. Máximo ${maxQ}. NO rellenes el cupo: si hay menos ideas, devolvé menos. Cero está bien si no hay nada extraíble (salvo SLOP: entonces 1).
- NO inventes cuántomos plausibles ni de relleno. Si el transcript es stub o inútil, quantomos = [] (salvo SLOP: 1 ítem literal).
- El peso humano ya está fijado (${weight}); no asignes hermetic_weight.
- actions = tareas accionables sugeridas (pocas).
- entities = menciones candidatas. NO asumas identidad canónica; devolvé el nombre tal cual aparece.
- type debe ser exactamente "person" o "project".
${slopRule}
- ruido = basura NER: calles/direcciones, topónimos oídos al pasar, fragmentos sin sentido como persona.
- NO incluyas lugares como type=project. Calles y direcciones van como person+ruido o se omiten.
- Preferí omitir ruido obvio; si dudás, marcá kind=ruido.
- Responde solo JSON.`
}

export async function extractFromTranscript(
  transcript: string,
  title: string,
  opts?: ExtractOpts,
): Promise<CohereExtraction> {
  const empty: CohereExtraction = {
    suggested_title: title,
    quantomos: [],
    actions: [],
    entities: [],
  }
  const useMock = opts?.fallback !== 'none'
  const fallback = (): CohereExtraction =>
    useMock
      ? clampExtraction(mockExtraction(transcript, title), opts)
      : empty

  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) {
    await delay(delayMs)
  }

  if (!apiKey) {
    return fallback()
  }

  try {
    const model =
      env('COHERE_MODEL_FAST') || env('COHERE_MODEL') || 'command-r-08-2024'

    const extras: string[] = []
    if (opts?.speakerContext) extras.push(opts.speakerContext)
    if (opts?.tagsContext) extras.push(opts.tagsContext)
    if (opts?.operatorNote) extras.push(`Nota operador:\n${opts.operatorNote}`)

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: buildAudioSystemPrompt(opts ?? {}) },
          {
            role: 'user',
            content: `Título actual: ${title}\n${extras.join('\n\n')}\n\nTranscript:\n${transcript}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere] API error:', res.status, errText)
      return fallback()
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }

    const raw =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      ''

    const parsed = parseJsonSafe(raw)
    if (parsed) {
      return clampExtraction(
        normalizeExtraction(parsed, title, transcript),
        opts,
      )
    }
    return fallback()
  } catch (err) {
    console.error('[cohere] failed, using mock:', err)
    return fallback()
  }
}

function clampExtraction(
  extraction: CohereExtraction,
  opts?: ExtractOpts,
): CohereExtraction {
  const maxQ =
    opts?.maxQuantomos != null
      ? Math.max(0, opts.maxQuantomos)
      : extraction.quantomos.length
  const weight = opts?.humanWeight
  let quantomos = extraction.quantomos.slice(0, maxQ)
  if (opts?.slop) {
    quantomos = quantomos.slice(0, 1)
    if (quantomos.length === 0) {
      quantomos = [
        {
          title: extraction.suggested_title || 'Audio slop',
          content: 'Transcripción de baja densidad; procesar como ruido.',
          hermetic_weight: weight ?? 1,
          universe: 'ruido',
        },
      ]
    }
  }
  if (weight != null) {
    quantomos = quantomos.map((q) => ({ ...q, hermetic_weight: weight }))
  }
  let entities = extraction.entities
  if (opts?.slop) {
    entities = entities.map((e) =>
      e.type === 'person' ? { ...e, kind: 'ruido' } : e,
    )
  }
  return { ...extraction, quantomos, entities }
}

function parseJsonSafe(raw: string): Partial<CohereExtraction> | null {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned) as Partial<CohereExtraction>
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Partial<CohereExtraction>
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeExtraction(
  partial: Partial<CohereExtraction>,
  fallbackTitle: string,
  transcript: string,
): CohereExtraction {
  const suggested = clampTitleWords(
    String(partial.suggested_title ?? ''),
    3,
    5,
    deriveFallbackTitle(transcript, fallbackTitle),
  )

  return {
    suggested_title: suggested,
    quantomos: Array.isArray(partial.quantomos)
      ? partial.quantomos.map((q) => ({
          title: String(q.title ?? 'Sin título'),
          content: String(q.content ?? ''),
          hermetic_weight: Number(q.hermetic_weight ?? 5),
          universe: String(q.universe ?? 'trinchera'),
        }))
      : [],
    actions: Array.isArray(partial.actions)
      ? partial.actions.map((a) => ({
          task_text: String(a.task_text ?? a),
          tag: String(a.tag ?? 'general'),
        }))
      : [],
    entities: Array.isArray(partial.entities)
      ? partial.entities
          .map((e) => normalizeEntity(e))
          .filter((e): e is NonNullable<typeof e> => e !== null)
      : [],
  }
}

function normalizeEntity(e: {
  name?: string
  type?: string
  kind?: string
  category?: string
  status?: string
  tactical_focus?: string
}): {
  name: string
  type: string
  kind?: string
  category?: string
  status?: string
  tactical_focus?: string
} | null {
  const name = String(e.name ?? '').trim()
  if (!name) return null

  const rawType = String(e.type ?? 'unknown').toLowerCase().trim()
  let type = 'unknown'
  if (
    [
      'person',
      'persona',
      'people',
      'fisica',
      'juridica',
      'agrupacion',
      'ficticia',
      'ficticio',
      'abstracta',
      'ruido',
    ].includes(rawType)
  ) {
    type = 'person'
  } else if (
    ['project', 'proyecto', 'initiative', 'iniciativa'].includes(rawType)
  ) {
    type = 'project'
  } else {
    return null
  }

  const out: {
    name: string
    type: string
    kind?: string
    category?: string
    status?: string
    tactical_focus?: string
  } = { name, type }

  if (type === 'person') {
    const kind = String(e.kind ?? rawType).toLowerCase()
    let resolved: string
    if (kind === 'agrupacion' || kind === 'ficticio') resolved = 'ficticia'
    else if (
      ['fisica', 'juridica', 'ficticia', 'abstracta', 'ruido'].includes(kind)
    ) {
      resolved = kind
    } else {
      resolved = 'fisica'
    }
    out.kind = refinePersonKind(name, resolved)
  } else {
    if (e.category) out.category = String(e.category)
    const st = String(e.status ?? 'emergente').toLowerCase()
    out.status = ['activo', 'pausado', 'cerrado', 'emergente'].includes(st)
      ? st
      : 'emergente'
    if (e.tactical_focus) out.tactical_focus = String(e.tactical_focus)
  }
  return out
}

function deriveFallbackTitle(transcript: string, title: string): string {
  const clean = transcript
    .replace(/\[STUB[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  const words = clean.split(/\s+/).filter((w) => w.length > 2).slice(0, 5)
  if (words.length >= 3) return words.join(' ')
  return clampTitleWords(`Nota sobre ${title}`, 3, 5, 'Nota de voz local')
}

function mockExtraction(transcript: string, title: string): CohereExtraction {
  const snippet = transcript.slice(0, 180).replace(/\s+/g, ' ').trim()
  return {
    suggested_title: deriveFallbackTitle(transcript, title),
    quantomos: [
      {
        title: `Esencia: ${title}`,
        content: snippet || `Nota derivada de ${title}`,
        hermetic_weight: 6,
        universe: 'trinchera',
      },
      {
        title: 'Señal local-first',
        content:
          'Mantener vault, SQLite y aduana HITL como núcleo operativo de Deprocast.',
        hermetic_weight: 7,
        universe: 'sistema',
      },
    ],
    actions: [
      {
        task_text: `Revisar y aprobar la entrada «${title}» en aduana`,
        tag: 'hitl',
      },
      {
        task_text: 'Confirmar timestamp_exact de la caminata',
        tag: 'origen',
      },
    ],
    entities: [
      {
        name: 'Deprocast',
        type: 'project',
        category: 'producto',
        status: 'activo',
        tactical_focus: 'local-first HITL',
      },
      {
        name: 'Operador',
        type: 'person',
        kind: 'fisica',
      },
    ],
  }
}

const BOOKMARK_CATEGORIES = [
  'HERRAMIENTAS',
  'CONCEPTOS',
  'ENTIDADES',
  'NEGOCIOS',
  'ARTE',
  'ARCHIVO',
] as const

const BOOKMARK_SYSTEM_PROMPT = `Eres el extractor de bookmarks de Deprocast. Recibes el texto de un tuit/bookmark guardado.
Puede venir metadata "Autor:" / "Link:" — eso es metadata del post, NO contenido a entity-izar.
Devuelve ÚNICAMENTE un JSON válido (sin markdown) con esta forma exacta:
{
  "category": "HERRAMIENTAS" | "CONCEPTOS" | "ENTIDADES" | "NEGOCIOS" | "ARTE" | "ARCHIVO",
  "quantomo": string,
  "suggested_title": string,
  "suggested_weight": number (1-12),
  "entities": [
    {
      "name": string,
      "type": "person" | "project",
      "kind": "fisica" | "juridica" | "ficticia" | "abstracta" | "ruido" (solo si type=person),
      "category": string (solo si type=project),
      "status": "activo" | "pausado" | "cerrado" | "emergente" (solo si type=project)
    }
  ]
}
Reglas:
- category = exactamente UNA de las 6 categorías.
  - HERRAMIENTAS: software, libs, prompts, workflows, gadgets.
  - CONCEPTOS: ideas, frameworks mentales, papers, tesis.
  - ENTIDADES: personas, empresas, lugares, marcas como foco principal.
  - NEGOCIOS: deals, modelos de negocio, pricing, fundraising.
  - ARTE: estética, diseño, cultura, media creativa.
  - ARCHIVO: referencia utilitaria / guardar por si acaso / bajo valor semántico.
- quantomo = UNA oración densa: la idea central destilada (español).
- suggested_title = 3 a 5 palabras, sin puntuación final.
- suggested_weight = tu estimación 1-12 (el operador ya asignó peso humano aparte).
- entities = SOLO nombres mencionados EN EL CUERPO del texto (no en Autor:/Link:).
  - NUNCA incluyas al Autor del post ni su @username como entidad, aunque aparezcan en metadata.
  - Personas reales identificables → type=person kind=fisica.
  - Empresas, marcas, estudios, orgs, cuentas institucionales → type=person kind=juridica (o type=project si es producto/iniciativa).
  - Personajes, roles narrativos inventados → type=person kind=ficticia.
  - Roles genéricos ("alguien", "la gente") → person+abstracta u omitir.
  - Lugares/calles/basura NER → omitir o person+ruido.
  - Clasificá kind con cuidado: NO defaults a fisica si es org/marca/ficticio.
- Responde solo JSON.`

export async function extractFromBookmark(
  text: string,
  meta?: { author?: string; link?: string },
): Promise<BookmarkExtraction> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) {
    await delay(delayMs)
  }

  if (!apiKey) {
    return mockBookmarkExtraction(text)
  }

  try {
    const model =
      env('COHERE_MODEL_FAST') || env('COHERE_MODEL') || 'command-r-08-2024'
    const author = meta?.author
      ? `\nAutor del post (metadata; NO extraer como entidad): ${meta.author}`
      : ''
    const link = meta?.link ? `\nLink: ${meta.link}` : ''

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: BOOKMARK_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Bookmark text:${author}${link}\n\nCuerpo:\n${text}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere/bookmark] API error:', res.status, errText)
      return mockBookmarkExtraction(text)
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }

    const raw =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      ''

    const parsed = parseJsonSafe(raw) as Partial<BookmarkExtraction> | null
    if (parsed) return normalizeBookmarkExtraction(parsed, text)
    return mockBookmarkExtraction(text)
  } catch (err) {
    console.error('[cohere/bookmark] failed, using mock:', err)
    return mockBookmarkExtraction(text)
  }
}

function normalizeCategory(raw: unknown): BookmarkCategory {
  const s = String(raw ?? '')
    .toUpperCase()
    .trim()
  if ((BOOKMARK_CATEGORIES as readonly string[]).includes(s)) {
    return s as BookmarkCategory
  }
  return 'CONCEPTOS'
}

function normalizeBookmarkExtraction(
  partial: Partial<BookmarkExtraction>,
  text: string,
): BookmarkExtraction {
  const quantomo = String(partial.quantomo ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const suggested = clampTitleWords(
    String(partial.suggested_title ?? ''),
    3,
    5,
    deriveFallbackTitle(text, 'Bookmark X'),
  )
  let suggestedWeight: number | null = null
  if (
    partial.suggested_weight != null &&
    Number.isFinite(Number(partial.suggested_weight))
  ) {
    suggestedWeight = Math.max(
      1,
      Math.min(12, Math.round(Number(partial.suggested_weight))),
    )
  }

  const entities = Array.isArray(partial.entities)
    ? partial.entities
        .map((e) => normalizeEntity(e))
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map((e) => ({
          name: e.name,
          type: e.type as 'person' | 'project',
          kind: e.kind,
          category: e.category,
          status: e.status,
        }))
    : []

  return {
    category: normalizeCategory(partial.category),
    quantomo:
      quantomo ||
      text.replace(/\s+/g, ' ').trim().slice(0, 220) ||
      'Idea capturada de bookmark',
    suggested_title: suggested,
    suggested_weight: suggestedWeight,
    entities,
  }
}

function mockBookmarkExtraction(text: string): BookmarkExtraction {
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 180)
  return {
    category: 'CONCEPTOS',
    quantomo: snippet || 'Idea capturada de bookmark',
    suggested_title: deriveFallbackTitle(text, 'Bookmark X'),
    suggested_weight: 7,
    entities: [],
    audio_summary: null,
    video_meta: null,
  }
}

const IG_REEL_SYSTEM_PROMPT = `Eres el extractor hermético de Deprocast para reels de Instagram.
Puede venir metadata "Autor:" / "Link:" — eso es metadata del post, NO contenido a entity-izar.
Devuelve ÚNICAMENTE un JSON válido (sin markdown) con esta forma exacta:
{
  "category": "HERRAMIENTAS" | "CONCEPTOS" | "ENTIDADES" | "NEGOCIOS" | "ARTE" | "ARCHIVO",
  "quantomo": string,
  "suggested_title": string,
  "suggested_weight": number (1-12),
  "audio_summary": string | null,
  "video_meta": string | null,
  "entities": [
    {
      "name": string,
      "type": "person" | "project",
      "kind": "fisica" | "juridica" | "ficticia" | "abstracta" | "ruido",
      "category": string,
      "status": "activo" | "pausado" | "cerrado" | "emergente"
    }
  ]
}
Reglas:
- suggested_title = 1 a 3 palabras en español, sin puntuación final. Resume el tema del reel.
- quantomo = una idea atómica densa (1–3 oraciones) a partir de la descripción y, si hay, transcript/OCR.
- audio_summary = resumen breve del habla del video si hay transcript; null si no hay.
- video_meta = síntesis de de qué va el video (descripción + audio + OCR); null si solo hay descripción corta.
- entities = SOLO menciones en descripción/transcript/OCR (no en Autor:/Link:).
  - NUNCA incluyas al Autor del reel ni su @username como entidad.
  - kind: fisica (persona real), juridica (marca/org/estudio), ficticia (personaje), abstracta/ruido según corresponda.
  - NO defaults a fisica si es org/marca/ficticio.
- Responde solo JSON.`

export type InstagramReelExtractInput = {
  description: string
  transcript?: string | null
  ocrFrames?: Array<{ t_sec: number; explanation: string }>
  author?: string
  link?: string
}

export async function extractFromInstagramReel(
  input: InstagramReelExtractInput,
): Promise<BookmarkExtraction> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

  const description = input.description.replace(/\s+/g, ' ').trim()
  if (!apiKey) {
    return mockInstagramExtraction(description, input)
  }

  try {
    const model =
      env('COHERE_MODEL_FAST') || env('COHERE_MODEL') || 'command-r-08-2024'
    const author = input.author
      ? `\nAutor del post (metadata; NO extraer como entidad): ${input.author}`
      : ''
    const link = input.link ? `\nLink: ${input.link}` : ''
    const transcript = input.transcript?.trim()
      ? `\n\nTranscript audio:\n${input.transcript.trim().slice(0, 8000)}`
      : ''
    const ocr =
      input.ocrFrames && input.ocrFrames.length > 0
        ? `\n\nOCR / fotogramas:\n${input.ocrFrames
            .map((f) => `[t=${f.t_sec}s] ${f.explanation}`)
            .join('\n')
            .slice(0, 8000)}`
        : ''

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: IG_REEL_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Reel Instagram:${author}${link}\n\nDescripción:\n${description}${transcript}${ocr}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere/ig] API error:', res.status, errText)
      return mockInstagramExtraction(description, input)
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }
    const raw =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      ''
    const parsed = parseJsonSafe(raw) as Partial<BookmarkExtraction> | null
    if (parsed) {
      const base = normalizeBookmarkExtraction(parsed, description)
      return {
        ...base,
        suggested_title: clampTitleWords(
          String(parsed.suggested_title ?? base.suggested_title),
          1,
          3,
          deriveFallbackTitle(description, 'Reel IG'),
        ),
        audio_summary: parsed.audio_summary
          ? String(parsed.audio_summary).trim()
          : input.transcript
            ? String(input.transcript).slice(0, 280)
            : null,
        video_meta: parsed.video_meta
          ? String(parsed.video_meta).trim()
          : null,
      }
    }
    return mockInstagramExtraction(description, input)
  } catch (err) {
    console.error('[cohere/ig] failed, using mock:', err)
    return mockInstagramExtraction(description, input)
  }
}

function mockInstagramExtraction(
  description: string,
  input: InstagramReelExtractInput,
): BookmarkExtraction {
  const snippet = description.slice(0, 180)
  return {
    category: 'CONCEPTOS',
    quantomo: snippet || 'Idea capturada de reel',
    suggested_title: clampTitleWords(
      deriveFallbackTitle(description, 'Reel IG'),
      1,
      3,
      'Reel IG',
    ),
    suggested_weight: 6,
    entities: [],
    audio_summary: input.transcript
      ? input.transcript.replace(/\s+/g, ' ').trim().slice(0, 280)
      : null,
    video_meta:
      input.ocrFrames && input.ocrFrames.length > 0
        ? `Video con ${input.ocrFrames.length} fotogramas analizados`
        : null,
  }
}

/** Explica un fotograma de reel con Cohere Vision. */
export async function explainVideoFrame(
  imageAbsPath: string,
  tSec: number,
): Promise<string> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

  if (!apiKey || !fs.existsSync(imageAbsPath)) {
    return `(t=${tSec}s) fotograma sin análisis`
  }

  try {
    const buf = fs.readFileSync(imageAbsPath)
    const b64 = buf.toString('base64')
    const model =
      env('COHERE_VISION_MODEL') || 'command-a-vision-07-2025'

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Fotograma de un reel de Instagram en t=${tSec}s. En 1–3 oraciones en español: qué se ve, texto en pantalla (OCR) y de qué parece tratar. Sé concreto.`,
              },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${b64}` },
              },
            ],
          },
        ],
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere/vision] API error:', res.status, errText)
      return `(t=${tSec}s) visión no disponible`
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }
    const text =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      ''
    return text.replace(/\s+/g, ' ').trim() || `(t=${tSec}s) vacío`
  } catch (err) {
    console.error('[cohere/vision] failed:', err)
    return `(t=${tSec}s) error de visión`
  }
}

export async function analyzeReelFrames(
  frames: Array<{ t_sec: number; absPath: string }>,
): Promise<OcrFrameResult[]> {
  const out: OcrFrameResult[] = []
  for (const f of frames) {
    const explanation = await explainVideoFrame(f.absPath, f.t_sec)
    out.push({
      t_sec: f.t_sec,
      path: f.absPath,
      explanation,
    })
  }
  return out
}

const NOTEBOOK_VISION_PROMPT = `Analizás una foto de cuaderno manuscrito (español). Puede ser UNA hoja, una TAPA, o una foto DOBLE (apertura con dos páginas y línea/gutter divisora en el medio).

Tu ÚNICA tarea es TRANSLITERAR lo que se ve. No interpretes, no resumas, no inventes contexto histórico ni temas que no estén escritos.

Devolvé ÚNICAMENTE JSON válido (sin markdown) con esta forma:
{
  "title": string (título corto 2-6 palabras tomado del texto visible; si no hay título, las primeras palabras legibles; si está en blanco, "Sin título"),
  "transcription_spatial": string (transliteración EXACTA del manuscrito; una línea del string = una línea visual. Si es spread, usá marcadores claros:
----- IZQUIERDA -----
...texto izq...
----- DERECHA -----
...texto der...),
  "graphic_elements": [
    {
      "type": "table" | "shape" | "connector" | "drawing" | "line",
      "bbox": [x, y, w, h] (0-1 normalizado sobre TODA la imagen),
      "label": string | null,
      "table": { "rows": string[][] } | null,
      "points": [[x,y], ...] | null
    }
  ],
  "is_blank": boolean,
  "meta": {
    "layout": "single" | "spread" | "cover" | "unknown",
    "notes": string (solo calidad de foto: orientación, sombra, gutter, recorte; SIN interpretar el contenido),
    "orientation_hint": 0 | 90 | 180 | 270,
    "page_bbox": [x, y, w, h] | null (bbox de la región útil de PAPEL a maximizar; excluí mesa/fondos),
    "spread": null | {
      "divider_x": number (0-1, posición horizontal del gutter/línea divisora),
      "left_bbox": [x, y, w, h],
      "right_bbox": [x, y, w, h],
      "left_title": string | null,
      "right_title": string | null,
      "left_transcription": string | null,
      "right_transcription": string | null
    }
  }
}
Reglas:
- Detectá SIEMPRE si la foto muestra dos páginas abiertas (spread). Si hay línea vertical/gutter en el centro o dos bloques de texto lado a lado → layout="spread" y completá meta.spread.
- En spread: transcribí IZQUIERDA y DERECHA por separado (en transcription_spatial con marcadores Y en meta.spread.*_transcription).
- page_bbox debe enmarcar el papel útil (no la mesa). Si es spread, page_bbox puede ser el cuaderno entero abierto.
- orientation_hint: rotación para que el texto quede derecho (0 si ya está).
- Preservá saltos de línea y ubicación; no “corrijas” ortografía salvo ilegibilidad ([?]).
- Copiá letras, números, títulos y listas TAL CUAL. Prohibido rellenar con prosa genérica (“esta es una página de notas…”, resúmenes de guerras, temas inventados).
- Si hay poco texto o casi vacío: transcribí solo lo visible (aunque sea una palabra al margen). is_blank=true solo si no hay tinta útil.
- Incluí tablas, formas, conectores, dibujos y líneas en graphic_elements (descripción mínima del dibujo, no un ensayo).
- Tapa lisa sin texto interior → layout="cover"; igual proponé título si hay etiqueta/marca.
- Responde solo JSON.`

function normalizeBBox(
  v: unknown,
): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length < 4) return null
  const nums = v.slice(0, 4).map((n) => Number(n))
  if (nums.some((n) => !Number.isFinite(n))) return null
  return [
    Math.min(1, Math.max(0, nums[0])),
    Math.min(1, Math.max(0, nums[1])),
    Math.min(1, Math.max(0, nums[2])),
    Math.min(1, Math.max(0, nums[3])),
  ]
}

function normalizeVisionMeta(
  raw: unknown,
): import('../types.js').NotebookPageVisionMeta {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const layoutRaw = String(m.layout || 'unknown')
  const layout =
    layoutRaw === 'single' ||
    layoutRaw === 'spread' ||
    layoutRaw === 'cover' ||
    layoutRaw === 'unknown'
      ? layoutRaw
      : 'unknown'
  const oh = Number(m.orientation_hint ?? 0)
  const orientation_hint =
    oh === 90 || oh === 180 || oh === 270 || oh === 0 ? oh : 0

  let spread: import('../types.js').NotebookPageVisionMeta['spread'] = null
  if (m.spread && typeof m.spread === 'object') {
    const s = m.spread as Record<string, unknown>
    const left = normalizeBBox(s.left_bbox)
    const right = normalizeBBox(s.right_bbox)
    if (left && right) {
      spread = {
        divider_x: Math.min(1, Math.max(0, Number(s.divider_x ?? 0.5))),
        left_bbox: left,
        right_bbox: right,
        left_title: s.left_title != null ? String(s.left_title) : null,
        right_title: s.right_title != null ? String(s.right_title) : null,
        left_transcription:
          s.left_transcription != null ? String(s.left_transcription) : null,
        right_transcription:
          s.right_transcription != null ? String(s.right_transcription) : null,
      }
    }
  }

  return {
    layout: spread ? 'spread' : layout,
    notes: m.notes != null ? String(m.notes) : null,
    orientation_hint,
    page_bbox: normalizeBBox(m.page_bbox),
    spread,
    error: m.error != null ? String(m.error) : null,
  }
}

export async function analyzeNotebookPage(
  imageAbsPath: string,
): Promise<import('../types.js').NotebookPageVisionResult> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

  if (!apiKey) {
    throw new Error('Falta COHERE_API_KEY en .env')
  }
  if (!fs.existsSync(imageAbsPath)) {
    throw new Error(`Imagen no encontrada: ${imageAbsPath}`)
  }

  const encoded = await encodeImageForVision(imageAbsPath)
  const model = env('COHERE_VISION_MODEL') || 'command-a-vision-07-2025'
  console.log(
    `[cohere/notebook-vision] ${path.basename(imageAbsPath)} → ${encoded.width}x${encoded.height} jpeg ${(encoded.bytes / 1024).toFixed(0)} KB`,
  )

  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: NOTEBOOK_VISION_PROMPT },
        {
          type: 'image_url' as const,
          image_url: { url: encoded.dataUrl },
        },
      ],
    },
  ]

  const call = async (withJsonFormat: boolean) => {
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages,
        ...(withJsonFormat ? { response_format: { type: 'json_object' } } : {}),
      }),
    })
    const errText = res.ok ? '' : await res.text()
    if (!res.ok) {
      const err = new Error(
        `Cohere visión ${res.status}: ${errText.slice(0, 400)}`,
      ) as Error & { status?: number }
      err.status = res.status
      throw err
    }
    return (await res.json()) as unknown
  }

  let data: unknown
  try {
    data = await call(true)
  } catch (err) {
    const status = (err as Error & { status?: number }).status
    if (
      (status === 500 || status === 502 || status === 503) ||
      (status === 429 && !/Trial key|1000 API calls/i.test(String(err)))
    ) {
      console.warn('[cohere/notebook-vision] reintento tras', status)
      await delay(Math.max(delayMs, 2500))
      data = await call(true)
    } else {
      throw err
    }
  }

  let raw = chatTextFromCohere(data)
  let parsed: Record<string, unknown>
  try {
    parsed = extractJsonObject(raw)
  } catch (parseErr) {
    console.warn(
      '[cohere/notebook-vision] JSON inválido, reintento sin response_format:',
      parseErr,
    )
    data = await call(false)
    raw = chatTextFromCohere(data)
    parsed = extractJsonObject(raw)
  }

  const elements = Array.isArray(parsed.graphic_elements)
    ? (parsed.graphic_elements as import('../types.js').GraphicElement[])
    : []
  const meta = normalizeVisionMeta(parsed.meta)

  let transcription = String(parsed.transcription_spatial || '')
  if (
    meta.spread &&
    !transcription.includes('----- IZQUIERDA') &&
    (meta.spread.left_transcription || meta.spread.right_transcription)
  ) {
    transcription = [
      '----- IZQUIERDA -----',
      meta.spread.left_transcription || '',
      '----- DERECHA -----',
      meta.spread.right_transcription || '',
    ].join('\n')
  }

  const title = String(parsed.title || '').trim() || 'Hoja sin título'
  console.log(
    `[cohere/notebook-vision] ok título="${title.slice(0, 60)}" tx=${transcription.length}c gráficos=${elements.length} blank=${Boolean(parsed.is_blank)}`,
  )

  return {
    title,
    transcription_spatial: transcription,
    graphic_elements: elements,
    is_blank: Boolean(parsed.is_blank),
    meta,
  }
}

export async function explainNotebookPage(input: {
  title: string
  transcription: string
  graphic_elements: import('../types.js').GraphicElement[]
  posicion: string
  numero_logico: number
}): Promise<string> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

  const graphicsSummary =
    input.graphic_elements.length > 0
      ? JSON.stringify(input.graphic_elements)
      : '(ninguno)'

  if (!apiKey) {
    return `Explicación (local): ${input.title}. ${input.transcription.slice(0, 400)}`
  }

  try {
    const model =
      env('COHERE_MODEL') || env('COHERE_MODEL_FAST') || 'command-r-plus-08-2024'
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'Sos el analista de cuadernos de Deprocast. Explicá en español (2-4 párrafos) el sentido de UNA hoja usando SOLO la transcripción y los elementos gráficos que te pasan. Prohibido inventar hechos, guerras, libros o temas que no estén en ese texto. Si la transcripción es una lista de títulos o está casi vacía, describí eso (estructura y palabras reales) sin rellenar. Sin markdown ni JSON.',
          },
          {
            role: 'user',
            content: `Hoja ${input.numero_logico} (${input.posicion})
Título: ${input.title}

Transcripción espacial:
${input.transcription}

Elementos gráficos:
${graphicsSummary}`,
          },
        ],
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere/notebook-explain]', res.status, errText)
      return `Explicación pendiente. Título: ${input.title}.`
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }
    const text =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      ''
    return text.trim() || `Explicación de: ${input.title}`
  } catch (err) {
    console.error('[cohere/notebook-explain] failed:', err)
    return `Explicación (fallback): ${input.title}`
  }
}

type NotebookEntity = {
  name: string
  type: 'person' | 'project'
  kind?: string
  category?: string
  status?: string
}

export async function extractNotebookEntities(input: {
  title: string
  transcription: string
  explanation: string
  mentioned?: Array<{ kind: string; entity_name: string }>
}): Promise<NotebookEntity[]> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

  if (!apiKey) return []

  try {
    const model =
      env('COHERE_MODEL_FAST') || env('COHERE_MODEL') || 'command-r-08-2024'
    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `Extraé entidades de una hoja de cuaderno. JSON único:
{"entities":[{"name":string,"type":"person"|"project","kind"?:string,"category"?:string,"status"?:string}]}
Reglas iguales a Deprocast NER. Solo JSON.`,
          },
          {
            role: 'user',
            content: `Título: ${input.title}\n\nTranscripción:\n${input.transcription}\n\nExplicación:\n${input.explanation}${
              input.mentioned?.length
                ? `\n\nEl operador ya señaló estas entidades (reconocelas y extraé otras relacionadas):\n${input.mentioned
                    .map((m) => `- ${m.entity_name} (${m.kind})`)
                    .join('\n')}`
                : ''
            }`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      console.error('[cohere/notebook-ner]', res.status, await res.text())
      return []
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }
    const raw =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      '{}'
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as {
      entities?: NotebookEntity[]
    }
    if (!Array.isArray(parsed.entities)) return []
    return parsed.entities
      .filter((e) => e?.name && (e.type === 'person' || e.type === 'project'))
      .map((e) => ({
        ...e,
        kind: e.type === 'person' ? refinePersonKind(e.name, e.kind) : e.kind,
      }))
  } catch (err) {
    console.error('[cohere/notebook-ner] failed:', err)
    return []
  }
}

const AGRUPACION_META_PROMPT = `Eres el analista de agrupaciones de Deprocast.
Recibes el nombre de una agrupación de personas, una lista de miembros, y notas libres del usuario (descripción o bullets).
Tu trabajo: entender la intención del usuario y derivar metadata estructurada que une a esos miembros.
Devuelve ÚNICAMENTE un JSON válido (sin markdown) con esta forma exacta:
{
  "summary": string,
  "tags": string[],
  "themes": string[],
  "related_person_names": string[],
  "related_categories": string[],
  "inferred_facts": string[]
}
Reglas:
- summary = 1-2 oraciones en español que capturan el criterio de la agrupación.
- tags = etiquetas cortas (1-3 palabras) útiles para filtrar.
- themes = temas o ejes (origen compartido, vínculo social, temática intelectual, tecnología, etc.).
- related_person_names = nombres de personas mencionadas en las notas (o miembros centrales), sin inventar.
- related_categories = categorías explícitas o implícitas (geográfica, temática, social, profesional…).
- inferred_facts = bullets cortos derivados de las notas + miembros (hechos o hipótesis suaves).
- No reescribas las notas del usuario; solo deriva metadata.
- Si las notas están vacías, inferí solo desde el nombre y los miembros, con cautela.
- Responde solo JSON.`

function emptyAgrupacionMeta(): AgrupacionGeneratedMeta {
  return {
    summary: '',
    tags: [],
    themes: [],
    related_person_names: [],
    related_categories: [],
    inferred_facts: [],
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean)
}

function normalizeAgrupacionMeta(
  parsed: Partial<AgrupacionGeneratedMeta> | null,
  name: string,
  notes: string,
  members: string[],
): AgrupacionGeneratedMeta {
  if (!parsed) {
    return mockAgrupacionMeta(name, notes, members)
  }
  return {
    summary: String(parsed.summary ?? '').trim() || `Agrupación: ${name}`,
    tags: asStringArray(parsed.tags),
    themes: asStringArray(parsed.themes),
    related_person_names: asStringArray(parsed.related_person_names),
    related_categories: asStringArray(parsed.related_categories),
    inferred_facts: asStringArray(parsed.inferred_facts),
  }
}

function mockAgrupacionMeta(
  name: string,
  notes: string,
  members: string[],
): AgrupacionGeneratedMeta {
  const bullets = notes
    .split(/\n|•|-/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2)
    .slice(0, 6)
  return {
    summary: notes.trim()
      ? `Criterio declarado para «${name}».`
      : `Agrupación «${name}» con ${members.length} miembro(s).`,
    tags: name
      .split(/\s+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 2)
      .slice(0, 4),
    themes: [],
    related_person_names: members.slice(0, 8),
    related_categories: [],
    inferred_facts: bullets.length > 0 ? bullets : emptyAgrupacionMeta().inferred_facts,
  }
}

function parseAgrupacionMetaJson(
  raw: string,
): Partial<AgrupacionGeneratedMeta> | null {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  try {
    return JSON.parse(cleaned) as Partial<AgrupacionGeneratedMeta>
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Partial<AgrupacionGeneratedMeta>
      } catch {
        return null
      }
    }
    return null
  }
}

export async function extractAgrupacionMeta(input: {
  name: string
  notes: string
  members: string[]
}): Promise<AgrupacionGeneratedMeta> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) {
    await delay(delayMs)
  }

  const { name, notes, members } = input

  if (!apiKey) {
    return mockAgrupacionMeta(name, notes, members)
  }

  try {
    const model =
      env('COHERE_MODEL_FAST') || env('COHERE_MODEL') || 'command-r-08-2024'

    const memberList =
      members.length > 0 ? members.map((m) => `- ${m}`).join('\n') : '(sin miembros)'

    const res = await fetch('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: AGRUPACION_META_PROMPT },
          {
            role: 'user',
            content: `Nombre de la agrupación: ${name}\n\nMiembros:\n${memberList}\n\nNotas del usuario:\n${notes || '(vacío)'}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere/agrupacion] API error:', res.status, errText)
      return mockAgrupacionMeta(name, notes, members)
    }

    const data = (await res.json()) as {
      message?: { content?: Array<{ type?: string; text?: string }> }
      text?: string
    }

    const raw =
      data.message?.content?.map((c) => c.text ?? '').join('') ||
      data.text ||
      ''

    const parsed = parseAgrupacionMetaJson(raw)
    return normalizeAgrupacionMeta(parsed, name, notes, members)
  } catch (err) {
    console.error('[cohere/agrupacion] failed, using mock:', err)
    return mockAgrupacionMeta(name, notes, members)
  }
}

function chatSystemPrompt(tipo: ChatTipo): string {
  const mode =
    tipo === 'grupo'
      ? `Modo GRUPO (multifacción): identificá quién propone qué, tensiones, acuerdos cruzados y menciones entre participantes.`
      : `Modo INDIVIDUAL (contacto clave 1:1): foco en relación colaborativa, acuerdos, proyectos compartidos y seguimiento táctico.`

  return `Eres el extractor de chats de Deprocast. Analizás un BLOQUE temporal de conversación (WhatsApp u similar).
${mode}
Devuelve ÚNICAMENTE un JSON válido (sin markdown):
{
  "title": string,
  "summary": string,
  "quantomo": string,
  "suggested_weight": number (1-12),
  "entities": [
    {
      "name": string,
      "type": "person" | "project",
      "kind": "fisica" | "juridica" | "ficticia" | "abstracta" | "ruido" (solo person),
      "category": string (solo project),
      "status": "activo" | "pausado" | "cerrado" | "emergente" (solo project)
    }
  ],
  "locations": string[],
  "milestones": string[]
}
Reglas:
- title = 3 a 5 palabras, sin puntuación final.
- summary = 2-4 oraciones del bloque (español).
- quantomo = UNA oración densa: la idea/acuerdo/hito central del bloque.
- entities = personas nombradas (no remitentes genéricos del propio chat si solo firman) y proyectos creativos/productoras/plataformas (ej. El Fotógrafo, Versa, Studianta, Terreta Hub).
- locations = zonas/ciudades/lugares logísticos mencionados.
- milestones = hitos temporales o entregables (escenas, estrenos, ferias).
- Omití ruido NER (calles sueltas sin contexto, interjecciones).
- Solo JSON.`
}

function mockChatExtraction(transcript: string, chatName: string): ChatExtraction {
  const contentLine =
    transcript
      .split('\n')
      .map((l) => l.replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '').trim())
      .find((l) => l && !l.startsWith('<')) || chatName
  return {
    title: clampTitleWords(contentLine, 3, 5, chatName || 'Bloque de chat'),
    summary: `Bloque del chat «${chatName}». ${contentLine}`,
    quantomo: `Hito conversacional en «${chatName}»: ${contentLine}`,
    suggested_weight: 7,
    entities: [],
    locations: [],
    milestones: [],
  }
}

function normalizeChatExtraction(
  partial: Partial<ChatExtraction> | null,
  transcript: string,
  chatName: string,
): ChatExtraction {
  const fallback = mockChatExtraction(transcript, chatName)
  if (!partial) return fallback
  const entities = Array.isArray(partial.entities)
    ? partial.entities
        .filter(
          (e) =>
            e &&
            typeof e.name === 'string' &&
            e.name.trim() &&
            (e.type === 'person' || e.type === 'project'),
        )
        .map((e) => ({
          name: e.name.trim(),
          type: e.type as 'person' | 'project',
          kind: e.kind,
          category: e.category,
          status: e.status,
        }))
    : []
  const weight =
    typeof partial.suggested_weight === 'number'
      ? Math.max(1, Math.min(12, Math.round(partial.suggested_weight)))
      : 7
  return {
    title: clampTitleWords(
      String(partial.title || fallback.title),
      3,
      5,
      fallback.title,
    ),
    summary: String(partial.summary || fallback.summary).trim(),
    quantomo: String(partial.quantomo || fallback.quantomo).trim(),
    suggested_weight: weight,
    entities,
    locations: Array.isArray(partial.locations)
      ? partial.locations.map(String).filter(Boolean)
      : [],
    milestones: Array.isArray(partial.milestones)
      ? partial.milestones.map(String).filter(Boolean)
      : [],
  }
}

export async function extractFromChatBlock(input: {
  chatName: string
  tipo: ChatTipo
  participantes: string[]
  transcript: string
  dayKey: string
}): Promise<ChatExtraction> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) await delay(delayMs)

  const { chatName, tipo, participantes, dayKey } = input
  // Limitar contexto para no reventar el modelo en bloques densos
  const transcript =
    input.transcript.length > 14000
      ? `${input.transcript.slice(0, 14000)}\n\n[…truncado…]`
      : input.transcript

  if (!apiKey) {
    throw new Error(
      'COHERE_API_KEY no configurada: no se puede analizar el bloque de chat',
    )
  }

  const model =
    env('COHERE_MODEL_FAST') || env('COHERE_MODEL') || 'command-r-08-2024'
  const plist =
    participantes.length > 0
      ? participantes.map((p) => `- ${p}`).join('\n')
      : '(desconocidos)'

  const res = await fetch('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: chatSystemPrompt(tipo) },
        {
          role: 'user',
          content: `Chat: ${chatName}\nTipo: ${tipo}\nJornada: ${dayKey}\nParticipantes del chat:\n${plist}\n\nBloque:\n${transcript}`,
        },
      ],
      response_format: { type: 'json_object' },
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('[cohere/chat]', res.status, errText)
    if (res.status === 429) {
      throw new Error(
        'Cohere rate limit (429). Esperá un minuto o subí la key a Production.',
      )
    }
    throw new Error(`Cohere chat extract falló (${res.status})`)
  }

  const data = (await res.json()) as {
    message?: { content?: Array<{ type?: string; text?: string }> }
    text?: string
  }
  const raw =
    data.message?.content?.map((c) => c.text ?? '').join('') ||
    data.text ||
    '{}'
  let parsed: Partial<ChatExtraction> | null = null
  try {
    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()
    parsed = JSON.parse(cleaned) as Partial<ChatExtraction>
  } catch (err) {
    console.error('[cohere/chat] JSON inválido:', raw.slice(0, 400))
    throw new Error('Cohere devolvió JSON inválido para el bloque de chat')
  }
  return normalizeChatExtraction(parsed, transcript, chatName)
}
