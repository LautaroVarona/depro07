import type { DatabaseSync } from 'node:sqlite'
import type {
  PersonProjectRole,
  PersonRelationType,
  ProjectKind,
} from '../types.js'

export const PROJECT_KINDS: ProjectKind[] = ['proyecto', 'tarea', 'concepto']

export const RELATION_TYPES: PersonRelationType[] = [
  'vinculo',
  'colabora',
  'familia',
  'conoce',
  'depende',
]

export const PERSON_PROJECT_ROLES: PersonProjectRole[] = [
  'responsable',
  'miembro',
  'participante',
  'interesado',
  'co_mentioned',
]

export function normalizeProjectKind(raw: unknown): ProjectKind {
  const s = String(raw ?? 'proyecto')
    .trim()
    .toLowerCase()
  if (s === 'tarea' || s === 'tareas' || s === 'reto' || s === 'retos') {
    return 'tarea'
  }
  if (s === 'concepto' || s === 'conceptos' || s === 'idea') {
    return 'concepto'
  }
  return 'proyecto'
}

export function normalizeRelationType(raw: unknown): PersonRelationType {
  const s = String(raw ?? 'vinculo')
    .trim()
    .toLowerCase()
  if (RELATION_TYPES.includes(s as PersonRelationType)) {
    return s as PersonRelationType
  }
  return 'vinculo'
}

export function normalizePersonProjectRole(raw: unknown): PersonProjectRole {
  const s = String(raw ?? 'miembro')
    .trim()
    .toLowerCase()
  if (s === 'co-mentioned' || s === 'comentioned') return 'co_mentioned'
  if (PERSON_PROJECT_ROLES.includes(s as PersonProjectRole)) {
    return s as PersonProjectRole
  }
  return 'miembro'
}

export function getOperatorId(db: DatabaseSync): string | null {
  const row = db
    .prepare(
      `SELECT id FROM persons
       WHERE is_operator = 1
         AND (merged_into IS NULL OR merged_into = '')
       LIMIT 1`,
    )
    .get() as { id: string } | undefined
  return row?.id ?? null
}
