/** Kinds de persona: perfiles maestros vs clasificación en Validador. */

export const PERSON_KINDS = [
  'fisica',
  'juridica',
  'ficticia',
  'abstracta',
  'ruido',
] as const

/** Solo estos pueden vivir en el roster de perfiles creados. */
export const PROFILE_KINDS = ['fisica', 'juridica', 'ficticia'] as const

export type PersonKind = (typeof PERSON_KINDS)[number]
export type ProfileKind = (typeof PROFILE_KINDS)[number]

export function normalizePersonKind(raw: unknown): PersonKind {
  const k = String(raw ?? '')
    .toLowerCase()
    .trim()
  if (k === 'agrupacion' || k === 'ficticio' || k === 'ficticia') {
    return 'ficticia'
  }
  if ((PERSON_KINDS as readonly string[]).includes(k)) {
    return k as PersonKind
  }
  if (k.includes('jurid') || k.includes('empresa') || k.includes('org')) {
    return 'juridica'
  }
  if (k.includes('abstract') || k.includes('concepto')) {
    return 'abstracta'
  }
  if (k.includes('ruido') || k.includes('noise') || k.includes('calle')) {
    return 'ruido'
  }
  return 'fisica'
}

export function isProfileKind(kind: string): kind is ProfileKind {
  return (PROFILE_KINDS as readonly string[]).includes(kind)
}
