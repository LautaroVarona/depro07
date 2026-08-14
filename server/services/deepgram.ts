import fs from 'node:fs'
import path from 'node:path'

export interface DiarizedUtterance {
  speaker: number
  start: number
  end: number
  transcript: string
}

export interface TranscriptResult {
  text: string
  stub: boolean
  utterances: DiarizedUtterance[]
}

function env(key: string, fallback = ''): string {
  return process.env[key]?.replace(/^["']|["']$/g, '') ?? fallback
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type DetectedAudio = {
  mime: string
  kind: 'adts' | 'mp4' | 'mp3' | 'ogg' | 'unknown'
}

/** Detecta formato real por magic bytes (Voice Memos a menudo es ADTS disfrazado de .m4a). */
export function detectAudioFormat(buf: Buffer): DetectedAudio {
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) {
    return { mime: 'audio/aac', kind: 'adts' }
  }
  if (buf.length >= 12) {
    const box = buf.slice(4, 8).toString('ascii')
    if (box === 'ftyp') return { mime: 'audio/mp4', kind: 'mp4' }
  }
  if (buf.length >= 3 && buf.slice(0, 3).toString('ascii') === 'ID3') {
    return { mime: 'audio/mpeg', kind: 'mp3' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return { mime: 'audio/mpeg', kind: 'mp3' }
  }
  if (buf.length >= 4 && buf.slice(0, 4).toString('ascii') === 'OggS') {
    return { mime: 'audio/ogg', kind: 'ogg' }
  }

  return { mime: 'application/octet-stream', kind: 'unknown' }
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.m4a':
    case '.mp4':
    case '.aac':
      return 'audio/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
    case '.oga':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.flac':
      return 'audio/flac'
    default:
      return 'application/octet-stream'
  }
}

/** Sample rates ADTS (ISO/IEC 14496-3). */
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
]

function adtsFrameLength(buf: Buffer, offset: number): number | null {
  if (offset + 7 > buf.length) return null
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xf0) !== 0xf0) return null
  const len =
    ((buf[offset + 3] & 0x03) << 11) |
    (buf[offset + 4] << 3) |
    ((buf[offset + 5] & 0xe0) >> 5)
  if (len < 7) return null
  return len
}

function adtsSampleRate(buf: Buffer, offset: number): number {
  const idx = (buf[offset + 2] & 0x3c) >> 2
  return ADTS_SAMPLE_RATES[idx] ?? 44100
}

/** Parte un stream ADTS en chunks de ~chunkSeconds. */
export function splitAdtsByDuration(
  buf: Buffer,
  chunkSeconds: number,
): Buffer[] {
  if (buf.length < 7) return [buf]

  const sampleRate = adtsSampleRate(buf, 0)
  const samplesPerFrame = 1024
  const framesPerChunk = Math.max(
    1,
    Math.ceil((chunkSeconds * sampleRate) / samplesPerFrame),
  )

  const chunks: Buffer[] = []
  let offset = 0
  let frameCount = 0
  let chunkStart = 0

  while (offset + 7 <= buf.length) {
    // resync if needed
    if (buf[offset] !== 0xff || (buf[offset + 1] & 0xf0) !== 0xf0) {
      offset += 1
      continue
    }
    const len = adtsFrameLength(buf, offset)
    if (!len || offset + len > buf.length) break

    frameCount += 1
    offset += len

    if (frameCount >= framesPerChunk) {
      chunks.push(buf.subarray(chunkStart, offset))
      chunkStart = offset
      frameCount = 0
    }
  }

  if (chunkStart < buf.length) {
    chunks.push(buf.subarray(chunkStart))
  }

  return chunks.length > 0 ? chunks : [buf]
}

function estimateAdtsDurationSec(buf: Buffer): number {
  const sampleRate = adtsSampleRate(buf, 0)
  let frames = 0
  let offset = 0
  while (offset + 7 <= buf.length) {
    if (buf[offset] !== 0xff || (buf[offset + 1] & 0xf0) !== 0xf0) {
      offset += 1
      continue
    }
    const len = adtsFrameLength(buf, offset)
    if (!len || offset + len > buf.length) break
    frames += 1
    offset += len
  }
  return (frames * 1024) / sampleRate
}

interface DeepgramJson {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string
        paragraphs?: { transcript?: string }
      }>
    }>
    utterances?: Array<{
      speaker?: number
      start?: number
      end?: number
      transcript?: string
    }>
  }
}

function extractTranscript(data: DeepgramJson): string {
  const alt = data.results?.channels?.[0]?.alternatives?.[0]
  const fromParagraphs = alt?.paragraphs?.transcript?.trim()
  if (fromParagraphs) return fromParagraphs
  return alt?.transcript?.trim() ?? ''
}

function extractUtterances(
  data: DeepgramJson,
  timeOffset = 0,
): DiarizedUtterance[] {
  const raw = data.results?.utterances
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw
    .map((u) => ({
      speaker: Number(u.speaker ?? 0) || 0,
      start: Number(u.start ?? 0) + timeOffset,
      end: Number(u.end ?? 0) + timeOffset,
      transcript: String(u.transcript ?? '').trim(),
    }))
    .filter((u) => u.transcript.length > 0)
}

function formatDiarizedText(utterances: DiarizedUtterance[]): string {
  if (utterances.length === 0) return ''
  const lines: string[] = []
  let last = -1
  for (const u of utterances) {
    if (u.speaker !== last) {
      lines.push(`\n[Speaker ${u.speaker}] ${u.transcript}`)
      last = u.speaker
    } else {
      lines.push(u.transcript)
    }
  }
  return lines.join('\n').trim()
}

async function deepgramListen(
  apiKey: string,
  audio: Buffer,
  mime: string,
  model: string,
  language: string,
): Promise<{ text: string; utterances: DiarizedUtterance[] }> {
  const params = new URLSearchParams({
    model,
    language,
    punctuate: 'true',
    paragraphs: 'true',
    smart_format: 'true',
    diarize: 'true',
    utterances: 'true',
  })

  const timeoutMs = Number(env('DEEPGRAM_TIMEOUT_MS', '90000')) || 90000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(
      `https://api.deepgram.com/v1/listen?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': mime,
        },
        body: new Uint8Array(audio),
        signal: controller.signal,
      },
    )

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Deepgram HTTP ${res.status}: ${errText}`)
    }

    const data = (await res.json()) as DeepgramJson
    const utterances = extractUtterances(data)
    const labeled = formatDiarizedText(utterances)
    const text = labeled || extractTranscript(data)
    return { text, utterances }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Deepgram timeout tras ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export type TranscribeProgress = {
  chunk: number
  total: number
  emptyStreak: number
}

/**
 * Transcribe un archivo. Si ADTS es largo, parte en chunks acotados
 * (nunca 300+ llamadas: eso bloqueaba toda la cola).
 */
export async function transcribeAudio(
  filePath: string,
  title: string,
  onProgress?: (partial: string, meta: TranscribeProgress) => void,
  shouldAbort?: () => boolean,
): Promise<TranscriptResult> {
  const dgKey = env('DEEPGRAM_API_KEY')
  if (!dgKey) {
    console.warn('[deepgram] sin DEEPGRAM_API_KEY → stub')
    const stub = stubTranscript(title)
    onProgress?.(stub.text, { chunk: 1, total: 1, emptyStreak: 0 })
    return stub
  }

  const audio = fs.readFileSync(filePath)
  if (audio.length < 64) {
    console.error(
      `[deepgram] archivo demasiado pequeño (${audio.length} B): ${filePath}`,
    )
    const stub = stubTranscript(title)
    onProgress?.(stub.text, { chunk: 1, total: 1, emptyStreak: 0 })
    return stub
  }

  const detected = detectAudioFormat(audio)
  const mime =
    detected.kind === 'unknown' ? mimeFromExt(filePath) : detected.mime

  const model = env('DEEPGRAM_MODEL', 'nova-3')
  const language = env('DEEPGRAM_LANGUAGE', 'es')
  let chunkSeconds = Number(env('DEEPGRAM_CHUNK_SECONDS', '50')) || 50
  const syncMaxSeconds = Number(env('DEEPGRAM_SYNC_MAX_SECONDS', '55')) || 55
  const chunkDelayMs = Number(env('DEEPGRAM_CHUNK_DELAY_MS', '400')) || 0
  const maxChunks = Number(env('DEEPGRAM_MAX_CHUNKS', '24')) || 24
  const maxEmptyStreak = Number(env('DEEPGRAM_MAX_EMPTY_STREAK', '6')) || 6

  console.log(
    `[deepgram] «${title}» ${audio.length} B · detect=${detected.kind} mime=${mime}`,
  )

  try {
    let parts: Buffer[] = [audio]

    if (detected.kind === 'adts') {
      const duration = estimateAdtsDurationSec(audio)
      console.log(
        `[deepgram] ADTS duración ≈ ${duration.toFixed(1)}s (chunk=${chunkSeconds}s, maxChunks=${maxChunks})`,
      )
      if (duration > syncMaxSeconds) {
        // Ajustar tamaño de chunk para no disparar cientos de POSTs
        const needed = Math.ceil(duration / maxChunks)
        if (needed > chunkSeconds) {
          chunkSeconds = needed
          console.warn(
            `[deepgram] chunkSeconds ↑ ${chunkSeconds}s para acotar a ≤${maxChunks} partes`,
          )
        }
        parts = splitAdtsByDuration(audio, chunkSeconds)
        if (parts.length > maxChunks) {
          console.warn(
            `[deepgram] ${parts.length} partes → truncando a ${maxChunks} (audio muy largo o sync ADTS ruidoso)`,
          )
          parts = parts.slice(0, maxChunks)
        }
        console.log(`[deepgram] split en ${parts.length} chunk(s)`)
      }
    } else if (audio.length > 8 * 1024 * 1024) {
      console.warn(
        '[deepgram] archivo grande no-ADTS: se envía entero (si falla, conviene convertir a AAC/ADTS)',
      )
    }

    const transcripts: string[] = []
    const allUtterances: DiarizedUtterance[] = []
    let emptyStreak = 0

    for (let i = 0; i < parts.length; i++) {
      if (shouldAbort?.()) {
        console.warn(`[deepgram] abort en chunk ${i + 1}/${parts.length}`)
        break
      }
      if (i > 0 && chunkDelayMs > 0) await delay(chunkDelayMs)

      let text = ''
      let chunkUtt: DiarizedUtterance[] = []
      try {
        const listened = await deepgramListen(
          dgKey,
          parts[i]!,
          mime,
          model,
          language,
        )
        text = listened.text
        const offset = i * chunkSeconds
        chunkUtt = listened.utterances.map((u) => ({
          ...u,
          start: u.start + offset,
          end: u.end + offset,
        }))
      } catch (err) {
        console.warn(
          `[deepgram] chunk ${i + 1}/${parts.length} error:`,
          err instanceof Error ? err.message : err,
        )
      }

      if (text) {
        transcripts.push(text)
        allUtterances.push(...chunkUtt)
        emptyStreak = 0
        console.log(
          `[deepgram] chunk ${i + 1}/${parts.length}: ${text.length} chars · ${chunkUtt.length} utt`,
        )
        onProgress?.(transcripts.join('\n\n').trim(), {
          chunk: i + 1,
          total: parts.length,
          emptyStreak,
        })
      } else {
        emptyStreak += 1
        console.warn(
          `[deepgram] chunk ${i + 1}/${parts.length}: vacío (racha ${emptyStreak})`,
        )
        onProgress?.(transcripts.join('\n\n').trim(), {
          chunk: i + 1,
          total: parts.length,
          emptyStreak,
        })
        if (emptyStreak >= maxEmptyStreak) {
          console.warn(
            `[deepgram] ${maxEmptyStreak} chunks vacíos seguidos → corto STT`,
          )
          break
        }
      }
    }

    const joined = transcripts.join('\n\n').trim()
    if (!joined) {
      console.error('[deepgram] transcript vacío tras chunks → stub')
      const stub = stubTranscript(title)
      onProgress?.(stub.text, {
        chunk: parts.length,
        total: parts.length,
        emptyStreak,
      })
      return stub
    }

    return { text: joined, stub: false, utterances: allUtterances }
  } catch (err) {
    console.error('[deepgram] failed, using stub:', err)
    const stub = stubTranscript(title)
    onProgress?.(stub.text, { chunk: 1, total: 1, emptyStreak: 0 })
    return stub
  }
}

function stubTranscript(title: string): TranscriptResult {
  const now = new Date().toISOString()
  const text = [
    `[STUB STT ${now}]`,
    `Transcripción simulada para «${title}».`,
    'Caminata matinal. Anoto ideas sobre el proyecto Deprocast,',
    'la trinchera de trabajo local-first y tareas pendientes:',
    'revisar el vault de audios, validar quántomos y aprobar propuestas en aduana.',
    'Marca temporal aproximada: 0:00 inicio, 0:15 ideas, 0:40 cierre.',
  ].join(' ')
  return { text, stub: true, utterances: [] }
}
