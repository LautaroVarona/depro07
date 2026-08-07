export type EntryStatus =
  | 'queued'
  | 'processing'
  | 'pending_review'
  | 'approved'
  | 'rejected'

export interface Entry {
  id: string
  notebook_id: string | null
  source_type: string
  title: string
  content_raw: string | null
  vault_path: string | null
  timestamp_exact: string | null
  status: EntryStatus
  created_at: string
  title_manual?: number
  original_filename?: string | null
}

export interface Quantomo {
  id: string
  entry_id: string
  title: string
  content: string | null
  hermetic_weight: number | null
  universe: string | null
  recognized: number
}

export interface PendingTask {
  id: string
  entry_id: string
  task_text: string
  tag: string | null
  status: string
}

/** Snapshot congelado al validar. */
export interface ValidatedFileMetadata {
  entry_id: string
  assigned_title: string
  timestamp_exact: string | null
  original_filename: string | null
  transcription: string | null
  stored_at: string
}

export type PersonKind =
  | 'fisica'
  | 'juridica'
  | 'ficticia'
  | 'abstracta'
  | 'ruido'
  | 'agrupacion'

export type ProjectStatus = 'activo' | 'pausado' | 'cerrado' | 'emergente'
export type ProjectKind = 'proyecto' | 'tarea' | 'concepto'
export type PersonRelationType =
  | 'vinculo'
  | 'colabora'
  | 'familia'
  | 'conoce'
  | 'depende'
export type PersonProjectRole =
  | 'responsable'
  | 'miembro'
  | 'participante'
  | 'interesado'
  | 'co_mentioned'

export interface ProposalBundle extends Entry {
  quantomos: Quantomo[]
  tasks: PendingTask[]
  file_metadata?: ValidatedFileMetadata | null
}

export interface Person {
  id: string
  name: string
  kind: PersonKind
  aliases: string
  aliases_list?: string[]
  notes: string | null
  status: string
  created_at: string
  updated_at: string
  source: string
  merged_into?: string | null
  is_operator?: number
  link_count?: number
  suggested_match?: {
    id: string
    name: string
    score: number
  } | null
  source_file?: string | null
  evidence_snippet?: string | null
}

export interface Project {
  id: string
  title: string
  category: string | null
  status: ProjectStatus | string
  tactical_focus: string | null
  notes: string | null
  aliases?: string
  aliases_list?: string[]
  created_at: string
  updated_at: string
  source: string
  merged_into?: string | null
  link_count?: number
  person_count?: number
  suggested_match?: {
    id: string
    name: string
    score: number
  } | null
  source_file?: string | null
  evidence_snippet?: string | null
}

export interface PersonRelation {
  id: string
  from_person_id: string
  to_person_id: string
  relation_type: PersonRelationType | string
  notes: string | null
  created_at: string
  from_name?: string
  to_name?: string
  other_id?: string
  other_name?: string
  direction?: 'out' | 'in'
}

export interface PersonProjectLink {
  id: string
  person_id: string
  project_id: string
  role: PersonProjectRole | string
  created_at: string
  person_name?: string
  project_title?: string
  project_category?: string | null
}

export interface EntityLink {
  id: string
  entity_kind: 'person' | 'project'
  entity_id: string
  entry_id: string
  quantomo_id: string | null
  role: string
  created_at: string
  entry_title?: string
  original_filename?: string | null
  timestamp_exact?: string | null
}

export interface EntityProposalView {
  id: string
  entry_id: string
  kind: 'person' | 'project'
  proposal_type: 'create' | 'link'
  suggested_name: string
  matched_entity_id: string | null
  status: string
  created_at: string
  meta: Record<string, unknown> & {
    kind?: string
    category?: string
    status?: string
    tactical_focus?: string
  }
  evidence_parsed: {
    snippet?: string
    entry_title?: string
    quantomo_id?: string | null
  }
  suggested_match: {
    id: string
    name: string
    score: number
  } | null
  entry_title?: string
}

/** Sugerencia de vínculo por co-ocurrencia (mismo entry_id). */
export interface GraphLinkSuggestion {
  person_id: string
  person_name: string
  project_id: string
  project_title: string
  shared_entry_count: number
  weight: number
  shared_entry_ids: string[]
  suggested_role: 'co_mentioned' | string
}

export interface GraphLinkEvidence {
  entry_id: string
  title: string
  snippet: string
  at: string | null
}

export interface GraphVizNode {
  id: string
  type: 'person' | 'project' | 'quantomo' | 'orphan'
  label: string
  kind?: string | null
  valence: number
  mass: number
  fog: boolean
  source?: string
  first_seen: string | null
  last_seen: string | null
  hermetic_weight?: number | null
  content?: string | null
  universe?: string | null
  entry_id?: string | null
  is_operator?: boolean
  orphan?: boolean
  status?: string | null
  aliases?: string[]
  proposal_id?: string | null
}

export interface GraphVizLink {
  id: string
  source: string
  target: string
  kind: 'confirmed' | 'suggested' | 'semantic' | 'orbit'
  role?: string
  weight: number
  similarity?: number
  created_at?: string | null
  evidence?: GraphLinkEvidence[]
}

export interface GraphHeatBucket {
  day: string
  count: number
}

export interface GraphSnapshot {
  nodes: GraphVizNode[]
  links: GraphVizLink[]
  time_range: { min: string | null; max: string | null }
  heatmap: GraphHeatBucket[]
  operator_id: string | null
  stats: {
    persons: number
    projects: number
    quantomos: number
    orphans: number
    confirmed_links: number
    suggested_links: number
    semantic_links: number
  }
}
