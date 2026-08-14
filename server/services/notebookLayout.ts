/** Layout canónico de cuaderno: 80 hojas de contenido + tapa/contratapa = 160 caras. */

export const TOTAL_SHEETS = 80
export const TOTAL_FACES = 160
/** Spreads de navegación: 0 tapa … 81 contratapa */
export const SPREAD_MAX = 81

export type PagePosicionVisual =
  | 'Tapa'
  | 'Suelta'
  | 'Izquierda'
  | 'Derecha'
  | 'Contratapa'

/** @deprecated alias de compatibilidad — preferir Tapa */
export type PagePosicionVisualLegacy = PagePosicionVisual | 'ImpactoTapa'

export type PageStatus =
  | 'Vacia'
  | 'PendienteVision'
  | 'PendienteValidacion'
  | 'Validada'
  | 'Procesada'

export interface VisualSlot {
  slot_index: number
  /** 0 = tapa/contratapa (no son páginas de contenido); 1..80 = páginas. */
  numero_logico: number
  posicion_visual: PagePosicionVisual
}

/**
 * slot 0 → Tapa (no es página 1)
 * slot 1 → Página 1 sola (choca con la tapa al abrir)
 * slots 2–157 → pares Izq/Der para páginas 2..79
 * slot 158 → Página 80 sola (choca con la contratapa)
 * slot 159 → Contratapa
 *
 * La tapa puede faltar (sin imagen): no pasa nada.
 */
export function mapVisualSlot(slotIndex: number): VisualSlot {
  if (slotIndex < 0 || slotIndex >= TOTAL_FACES) {
    throw new Error(`slot_index fuera de rango: ${slotIndex}`)
  }

  if (slotIndex === 0) {
    return { slot_index: 0, numero_logico: 0, posicion_visual: 'Tapa' }
  }

  if (slotIndex === 1) {
    return { slot_index: 1, numero_logico: 1, posicion_visual: 'Suelta' }
  }

  if (slotIndex === TOTAL_FACES - 2) {
    return {
      slot_index: TOTAL_FACES - 2,
      numero_logico: TOTAL_SHEETS,
      posicion_visual: 'Suelta',
    }
  }

  if (slotIndex === TOTAL_FACES - 1) {
    return {
      slot_index: TOTAL_FACES - 1,
      numero_logico: 0,
      posicion_visual: 'Contratapa',
    }
  }

  // slots 2..157 → páginas 2..79 en pares
  const pairOffset = slotIndex - 2
  const numero_logico = 2 + Math.floor(pairOffset / 2)
  const posicion_visual: PagePosicionVisual =
    pairOffset % 2 === 0 ? 'Izquierda' : 'Derecha'

  return { slot_index: slotIndex, numero_logico, posicion_visual }
}

export function allVisualSlots(): VisualSlot[] {
  return Array.from({ length: TOTAL_FACES }, (_, i) => mapVisualSlot(i))
}

/**
 * 0 = Tapa
 * 1 = Página 1
 * 2..79 = aperturas páginas 2..79
 * 80 = Página 80
 * 81 = Contratapa
 */
export function spreadIndexForSlot(slotIndex: number): number {
  if (slotIndex === 0) return 0
  if (slotIndex === 1) return 1
  if (slotIndex === TOTAL_FACES - 2) return 80
  if (slotIndex === TOTAL_FACES - 1) return SPREAD_MAX
  return 2 + Math.floor((slotIndex - 2) / 2)
}

export function slotsForSpread(spreadIndex: number): number[] {
  if (spreadIndex === 0) return [0]
  if (spreadIndex === 1) return [1]
  if (spreadIndex === 80) return [TOTAL_FACES - 2]
  if (spreadIndex === SPREAD_MAX) return [TOTAL_FACES - 1]
  if (spreadIndex < 2 || spreadIndex > 79) {
    throw new Error(`spreadIndex fuera de rango: ${spreadIndex}`)
  }
  const left = 2 + (spreadIndex - 2) * 2
  return [left, left + 1]
}

export function labelForSlot(slot: VisualSlot): string {
  if (slot.posicion_visual === 'Tapa') return 'Tapa'
  if (slot.posicion_visual === 'Contratapa') return 'Contratapa'
  if (slot.posicion_visual === 'Suelta') {
    return `Página ${slot.numero_logico}`
  }
  const side = slot.posicion_visual === 'Izquierda' ? 'Izq' : 'Der'
  return `Página ${slot.numero_logico} · ${side}`
}

export function spreadLabel(spreadIndex: number): string {
  if (spreadIndex === 0) return 'Tapa'
  if (spreadIndex === 1) return 'Página 1'
  if (spreadIndex === 80) return 'Página 80'
  if (spreadIndex === SPREAD_MAX) return 'Contratapa'
  return `Apertura página ${spreadIndex}`
}

/** Normaliza valores legacy ImpactoTapa → Tapa en lecturas. */
export function normalizePosicion(
  raw: string | null | undefined,
): PagePosicionVisual {
  if (raw === 'ImpactoTapa') return 'Tapa'
  if (
    raw === 'Tapa' ||
    raw === 'Suelta' ||
    raw === 'Izquierda' ||
    raw === 'Derecha' ||
    raw === 'Contratapa'
  ) {
    return raw
  }
  return 'Suelta'
}
