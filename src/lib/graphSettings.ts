export interface GraphColorTheme {
  person: string
  project: string
  quantomo: string
  orphan: string
  fog: string
  linkConfirmed: string
  linkSuggested: string
  linkOrbit: string
  bg: string
  hud: string
}

export interface GraphLayerSettings {
  showPersons: boolean
  personFisica: boolean
  personJuridica: boolean
  personFicticia: boolean
  showProjects: boolean
  projectProyecto: boolean
  projectTarea: boolean
  projectConcepto: boolean
  showQuantomos: boolean
  showOrphans: boolean
  showSuggestions: boolean
  quantomoWeightMin: number
  quantomoWeightMax: number
  nodeSizeScale: number
  chargeStrength: number
  linkGravity: number
  focusMode: boolean
  godMode: boolean
  /** growth = existía para esa fecha; momentum = activo ese día */
  timeMode: 'growth' | 'momentum'
}

export interface GraphSettings {
  layers: GraphLayerSettings
  colors: GraphColorTheme
}

const STORAGE_KEY = 'deprocast.graph.settings.v1'

export const DEFAULT_COLORS: GraphColorTheme = {
  person: '#c4a35a',
  project: '#6a9e7a',
  quantomo: '#e8e4dc',
  orphan: '#c45c4a',
  fog: 'rgba(22,25,29,0.45)',
  linkConfirmed: 'rgba(184,178,168,0.65)',
  linkSuggested: 'rgba(196,163,90,0.5)',
  linkOrbit: 'rgba(232,228,220,0.22)',
  bg: '#0e1012',
  hud: '#16191d',
}

export const DEFAULT_LAYERS: GraphLayerSettings = {
  showPersons: true,
  personFisica: true,
  personJuridica: true,
  personFicticia: true,
  showProjects: true,
  projectProyecto: true,
  projectTarea: true,
  projectConcepto: true,
  showQuantomos: true,
  showOrphans: true,
  showSuggestions: true,
  quantomoWeightMin: 1,
  quantomoWeightMax: 12,
  nodeSizeScale: 1,
  chargeStrength: -180,
  linkGravity: 1,
  focusMode: true,
  godMode: false,
  timeMode: 'growth',
}

export const DEFAULT_SETTINGS: GraphSettings = {
  layers: { ...DEFAULT_LAYERS },
  colors: { ...DEFAULT_COLORS },
}

export function loadGraphSettings(): GraphSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_SETTINGS)
    const parsed = JSON.parse(raw) as Partial<GraphSettings>
    const colors = { ...DEFAULT_COLORS, ...(parsed.colors ?? {}) }
    // Sanear fondo inválido o demasiado claro (rompe el noir)
    const hex = colors.bg?.startsWith('#') ? colors.bg.slice(1) : ''
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((c) => c + c)
            .join('')
        : hex
    const n = full.length === 6 ? Number.parseInt(full, 16) : NaN
    if (
      !colors.bg ||
      Number.isNaN(n) ||
      ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) > 420
    ) {
      colors.bg = DEFAULT_COLORS.bg
    }
    return {
      layers: { ...DEFAULT_LAYERS, ...(parsed.layers ?? {}) },
      colors,
    }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveGraphSettings(settings: GraphSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* ignore quota */
  }
}
