/** Detecta títulos tipo fecha/grabación genérica → se pueden auto-nombrar. */
export function isAutoNameCandidate(title: string): boolean {
  const t = title.trim()
  if (!t) return true
  if (
    /(\d{1,2})\s*(?:de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)/i.test(
      t,
    )
  ) {
    return true
  }
  if (/^\d{4}[-_.]\d{2}[-_.]\d{2}/.test(t)) return true
  if (/^(recording|audio|grabaci[oó]n|nota[-_\s]?sin[-_\s]?fecha)/i.test(t)) {
    return true
  }
  if (/^\d{1,2}[.:]\d{2}/.test(t)) return true
  return false
}

/** Normaliza a entre 3 y 5 palabras. */
export function clampTitleWords(
  raw: string,
  min = 3,
  max = 5,
  fallback = 'Nota de voz local',
): string {
  const words = raw
    .replace(/[«»""]/g, '')
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) return fallback
  if (words.length < min) {
    const pad = fallback.split(/\s+/)
    return [...words, ...pad].slice(0, min).join(' ')
  }
  return words.slice(0, max).join(' ')
}
