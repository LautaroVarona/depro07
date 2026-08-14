/**
 * Parser universal de exportaciones WhatsApp (.txt).
 * Formato A: DD/MM/AAAA, HH:MM - Remitente: Mensaje
 * Formato B: [DD/MM/AA HH:MM:SS] Remitente: Mensaje
 */
import { randomUUID } from 'node:crypto'
import type { ChatTipo } from '../types.js'
import { extractUrls, hashContent } from './linkHarvest.js'

export type ParsedChatMessage = {
  id: string
  remitente: string | null
  texto_crudo: string
  timestamp_exact: string
  is_system: boolean
  is_media: boolean
  urls: string[]
  sort_index: number
}

export type ParsedChat = {
  origin_hash: string
  suggested_name: string
  tipo_auto: ChatTipo
  participantes: string[]
  messages: ParsedChatMessage[]
  link_count: number
  system_count: number
  media_count: number
  first_ts: string | null
  last_ts: string | null
}

/** Formato A: 11/3/2025, 18:52 - Name: msg  OR  11/3/25, 18:52 - Name: msg */
const RE_A =
  /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(?:([^:]+):\s)?([\s\S]*)$/

/** Formato B: [11/3/25 18:52:03] Name: msg */
const RE_B =
  /^\[(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(?:([^:]+):\s)?([\s\S]*)$/

const SYSTEM_HINTS = [
  'los mensajes y las llamadas están cifrados',
  'creaste este grupo',
  'se añadió',
  'se agregó',
  'se unió',
  'salió del grupo',
  'cambiaste el',
  'cambió el',
  'cambiaste la descripción',
  'cambió la descripción',
  'cambiaste el icono',
  'eliminaste este mensaje',
  'este mensaje fue eliminado',
  'ahora eres admin',
  'ya no eres admin',
  'te añadieron',
  'te agregaron',
  'security code changed',
  'messages and calls are end-to-end encrypted',
  'created this group',
  'changed the group description',
  'changed this group',
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function parseDateParts(
  dateStr: string,
  timeStr: string,
): string | null {
  const dp = dateStr.split('/').map((x) => Number(x))
  if (dp.length !== 3 || dp.some((n) => Number.isNaN(n))) return null
  let [d, m, y] = dp
  if (y < 100) y += 2000
  const tp = timeStr.split(':').map((x) => Number(x))
  if (tp.length < 2 || tp.some((n) => Number.isNaN(n))) return null
  const hh = tp[0]
  const mm = tp[1]
  const ss = tp[2] ?? 0
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  // Local civil time as ISO-like without TZ shift (store as local wall clock)
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`
}

function isSystemLine(remitente: string | null, text: string): boolean {
  if (!remitente) return true
  const lower = text.toLowerCase()
  return SYSTEM_HINTS.some((h) => lower.includes(h))
}

function isMediaText(text: string): boolean {
  const t = text.trim().toLowerCase()
  return (
    t === '<multimedia omitido>' ||
    t === '<media omitted>' ||
    t === 'multimedia omitida' ||
    t.includes('<multimedia omitido>') ||
    t.includes('<media omitted>')
  )
}

function suggestNameFromFilename(filename?: string | null): string {
  if (!filename) return 'Chat importado'
  let base = filename.replace(/\.[^.]+$/, '')
  base = base
    .replace(/^Chat de WhatsApp con\s+/i, '')
    .replace(/^WhatsApp Chat with\s+/i, '')
    .replace(/^Conversación de WhatsApp con\s+/i, '')
    .trim()
  return base || 'Chat importado'
}

/** Quita emoji/símbolos para fusionar alias del mismo remitente (ej. Lautaro❤️). */
function normalizeParticipantKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function dedupeParticipantes(names: string[]): string[] {
  const unique = [...new Set(names.filter(Boolean))]
  const kept: string[] = []
  for (const n of unique) {
    const key = normalizeParticipantKey(n)
    if (!key) continue
    const overlapIdx = kept.findIndex((other) => {
      const ok = normalizeParticipantKey(other)
      return (
        ok === key ||
        ok.startsWith(key) ||
        key.startsWith(ok) ||
        ok.includes(key) ||
        key.includes(ok)
      )
    })
    if (overlapIdx < 0) {
      kept.push(n)
      continue
    }
    // Prefer longer / more informative display name
    if (n.length > kept[overlapIdx].length) kept[overlapIdx] = n
  }
  return kept
}

type HeaderMatch = {
  timestamp_exact: string
  remitente: string | null
  text: string
}

function tryMatchHeader(line: string): HeaderMatch | null {
  let m = line.match(RE_A)
  if (m) {
    const ts = parseDateParts(m[1], m[2])
    if (!ts) return null
    const hasSender = m[3] != null && m[3].trim() !== ''
    return {
      timestamp_exact: ts,
      remitente: hasSender ? m[3].trim() : null,
      text: (m[4] ?? '').trimEnd(),
    }
  }
  m = line.match(RE_B)
  if (m) {
    const ts = parseDateParts(m[1], m[2])
    if (!ts) return null
    const hasSender = m[3] != null && m[3].trim() !== ''
    return {
      timestamp_exact: ts,
      remitente: hasSender ? m[3].trim() : null,
      text: (m[4] ?? '').trimEnd(),
    }
  }
  return null
}

export function parseWhatsAppExport(
  rawText: string,
  opts?: { filename?: string | null },
): ParsedChat {
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const messages: ParsedChatMessage[] = []
  let current: ParsedChatMessage | null = null
  let sort = 0

  const flush = () => {
    if (!current) return
    current.urls = extractUrls(current.texto_crudo)
    current.is_media = isMediaText(current.texto_crudo)
    if (!current.is_system) {
      current.is_system = isSystemLine(current.remitente, current.texto_crudo)
    }
    messages.push(current)
    current = null
  }

  for (const line of lines) {
    const header = tryMatchHeader(line)
    if (header) {
      flush()
      const sys =
        header.remitente == null ||
        isSystemLine(header.remitente, header.text)
      current = {
        id: randomUUID(),
        remitente: header.remitente,
        texto_crudo: header.text,
        timestamp_exact: header.timestamp_exact,
        is_system: sys,
        is_media: false,
        urls: [],
        sort_index: sort++,
      }
      continue
    }
    if (current) {
      current.texto_crudo = `${current.texto_crudo}\n${line}`
    }
  }
  flush()

  const participantes = dedupeParticipantes(
    messages
      .filter((m) => !m.is_system && m.remitente)
      .map((m) => m.remitente as string),
  )
  const tipo_auto: ChatTipo = participantes.length > 2 ? 'grupo' : 'individual'
  let link_count = 0
  let system_count = 0
  let media_count = 0
  for (const m of messages) {
    link_count += m.urls.length
    if (m.is_system) system_count++
    if (m.is_media) media_count++
  }

  const contentMsgs = messages.filter((m) => !m.is_system)
  const first_ts = contentMsgs[0]?.timestamp_exact ?? messages[0]?.timestamp_exact ?? null
  const last_ts =
    contentMsgs[contentMsgs.length - 1]?.timestamp_exact ??
    messages[messages.length - 1]?.timestamp_exact ??
    null

  return {
    origin_hash: hashContent(text),
    suggested_name: suggestNameFromFilename(opts?.filename),
    tipo_auto,
    participantes,
    messages,
    link_count,
    system_count,
    media_count,
    first_ts,
    last_ts,
  }
}
