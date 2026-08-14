/**
 * Guardas NER: excluir autores de posts y refinar kind de personas.
 */
import {
  normalizePersonKind,
  type PersonKind,
} from './personKinds.js'

function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stripAt(raw: string): string {
  return raw.trim().replace(/^@+/, '')
}

/** Claves normalizadas para comparar un autor de bookmark/post. */
export function authorMatchKeys(
  authorName?: string | null,
  authorUsername?: string | null,
): Set<string> {
  const keys = new Set<string>()
  const name = String(authorName ?? '').trim()
  const user = stripAt(String(authorUsername ?? ''))
  if (name) {
    const n = normalizeName(name)
    if (n) keys.add(n)
    // "Nick Arner @nickarner" → solo la parte nombre
    const beforeAt = name.split('@')[0]?.trim()
    if (beforeAt) {
      const bn = normalizeName(beforeAt)
      if (bn) keys.add(bn)
    }
  }
  if (user) {
    const u = normalizeName(user)
    if (u) keys.add(u)
    keys.add(user.toLowerCase())
  }
  return keys
}

/** True si la mención NER es el autor del post (no una mención en el cuerpo). */
export function matchesSourceAuthor(
  entityName: string,
  authorName?: string | null,
  authorUsername?: string | null,
): boolean {
  const keys = authorMatchKeys(authorName, authorUsername)
  if (keys.size === 0) return false
  const raw = String(entityName ?? '').trim()
  if (!raw) return false

  const candidates = new Set<string>()
  const add = (s: string) => {
    const n = normalizeName(s)
    if (n) candidates.add(n)
    const stripped = normalizeName(stripAt(s))
    if (stripped) candidates.add(stripped)
    const lower = stripAt(s).toLowerCase()
    if (lower) candidates.add(lower)
  }

  add(raw)
  // "Nick Arner @nickarner" / "thermo @DionysianAgent"
  for (const part of raw.split(/[@|]/).map((p) => p.trim()).filter(Boolean)) {
    add(part)
  }
  // "Name (@handle)" residual
  const handleMatch = raw.match(/@([\w.]+)/)
  if (handleMatch?.[1]) add(handleMatch[1])

  for (const c of candidates) {
    if (keys.has(c)) return true
  }
  return false
}

export function filterSourceAuthorEntities<T extends { name: string }>(
  entities: T[],
  authorName?: string | null,
  authorUsername?: string | null,
): T[] {
  if (!authorName && !authorUsername) return entities
  return entities.filter(
    (e) => !matchesSourceAuthor(e.name, authorName, authorUsername),
  )
}

const JURIDICA_RE =
  /\b(inc|llc|ltd|gmbh|s\.?\s?a\.?|s\.?\s?l\.?|corp|corporation|company|co\.|fundaci[oó]n|foundation|university|universidad|institute|instituto|studios?|records|agency|agencia|museum|museo|labs?|limited|holdings?|group|grupo|assoc(?:iation)?|asociaci[oó]n|ong|ngo|club)\b/i

const FICTICIA_RE =
  /\b(character|personaje|fictional|fictici[oa]|avatar|npc|alter\s*ego)\b/i

/**
 * Si el modelo dejó kind=fisica por defecto, intenta elevar a juridica/ficticia
 * con señales léxicas claras. No baja de juridica/ficticia a fisica.
 */
export function refinePersonKind(
  name: string,
  kind: PersonKind | string | null | undefined,
): PersonKind {
  const base = normalizePersonKind(kind)
  const n = String(name ?? '').trim()
  if (!n) return base

  if (base === 'abstracta' || base === 'ruido') return base

  if (JURIDICA_RE.test(n) || /[&]/.test(n)) {
    return 'juridica'
  }
  if (FICTICIA_RE.test(n)) {
    return 'ficticia'
  }

  // Handles sueltos (@marca) suelen ser marcas/orgs, no personas físicas
  if (/^@[\w.]+$/.test(n) && base === 'fisica') {
    return 'juridica'
  }

  return base
}
