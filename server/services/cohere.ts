import type { CohereExtraction } from '../types.js'
import { clampTitleWords } from './titleUtils.js'

function env(key: string, fallback = ''): string {
  return process.env[key]?.replace(/^["']|["']$/g, '') ?? fallback
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const SYSTEM_PROMPT = `Eres el extractor hermético de Deprocast. Recibes un transcript en español de una nota de voz/caminata.
Devuelve ÚNICAMENTE un JSON válido (sin markdown) con esta forma exacta:
{
  "suggested_title": string,
  "quantomos": [
    { "title": string, "content": string, "hermetic_weight": number (1-10), "universe": string }
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
- suggested_title = nombre corto del audio, entre 3 y 5 palabras, en español, sin comillas ni puntuación final. Resume el tema central.
- quantomos = ideas atómicas densas extraídas del transcript.
- actions = tareas accionables sugeridas.
- entities = menciones candidatas. NO asumas identidad canónica; devolvé el nombre tal cual aparece.
- type debe ser exactamente "person" o "project".
- kind (person):
  - fisica = persona real identificable (nombre propio).
  - juridica = empresa, estudio, marca, organización.
  - ficticia = personaje, apodo inventado, rol narrativo con nombre propio inventado.
  - abstracta = roles genéricos sin identidad ("el inversor", "el hablante", "el narrador", "la gente").
  - ruido = basura NER: calles/direcciones, topónimos oídos al pasar, fragmentos sin sentido como persona.
- NO incluyas lugares como type=project. Calles y direcciones van como person+ruido o se omiten.
- Preferí omitir ruido obvio; si dudás, marcá kind=ruido.
- Si el transcript es stub o pobre, igual genera 1-3 ítems plausibles y un suggested_title coherente.
- Responde solo JSON.`

export async function extractFromTranscript(
  transcript: string,
  title: string,
): Promise<CohereExtraction> {
  const apiKey = env('COHERE_API_KEY')
  const delayMs = Number(env('COHERE_REQUEST_DELAY_MS', '2000')) || 0
  if (delayMs > 0) {
    await delay(delayMs)
  }

  if (!apiKey) {
    return mockExtraction(transcript, title)
  }

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
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Título actual: ${title}\n\nTranscript:\n${transcript}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('[cohere] API error:', res.status, errText)
      return mockExtraction(transcript, title)
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
    if (parsed) return normalizeExtraction(parsed, title, transcript)
    return mockExtraction(transcript, title)
  } catch (err) {
    console.error('[cohere] failed, using mock:', err)
    return mockExtraction(transcript, title)
  }
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
    if (kind === 'agrupacion' || kind === 'ficticio') out.kind = 'ficticia'
    else if (
      ['fisica', 'juridica', 'ficticia', 'abstracta', 'ruido'].includes(kind)
    ) {
      out.kind = kind
    } else {
      out.kind = 'fisica'
    }
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
