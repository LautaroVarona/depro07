export type EntryStatus = 'queued' | 'processing' | 'pending_review' | 'approved' | 'rejected'

export interface Notebook {
  id: string
  title: string
  created_at: string
}

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
  title_manual: number
  original_filename: string | null
}

/** Snapshot congelado al validar: nombre asignado, fecha, archivo original y transcripción. */
export interface ValidatedFileMetadata {
  entry_id: string
  assigned_title: string
  timestamp_exact: string | null
  original_filename: string | null
  transcription: string | null
  stored_at: string
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

export interface CohereQuantomo {
  title: string
  content: string
  hermetic_weight: number
  universe: string
}

export interface CohereAction {
  task_text: string
  tag: string
}

export type EntityKind = 'person' | 'project'
export type PersonKind =
  | 'fisica'
  | 'juridica'
  | 'ficticia'
  | 'abstracta'
  | 'ruido'
  /** @deprecated migrado a ficticia */
  | 'agrupacion'
export type ProjectStatus = 'activo' | 'pausado' | 'cerrado' | 'emergente'
export type ProjectKind = 'proyecto' | 'tarea' | 'concepto'
export type ProposalType = 'create' | 'link'
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
export type ProposalStatus = 'pending' | 'approved' | 'rejected'
export type EmbeddingObjectType =
  | 'entry'
  | 'quantomo'
  | 'person'
  | 'project'
  | 'link_context'

export interface CohereEntity {
  name: string
  type: string
  kind?: string
  category?: string
  status?: string
  tactical_focus?: string
}

export interface CohereExtraction {
  suggested_title: string
  quantomos: CohereQuantomo[]
  actions: CohereAction[]
  entities: CohereEntity[]
}

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
  notes: string | null
  status: string
  created_at: string
  updated_at: string
  source: string
  merged_into?: string | null
  is_operator?: number
}

export interface Project {
  id: string
  title: string
  category: string | null
  status: ProjectStatus | string
  tactical_focus: string | null
  notes: string | null
  aliases?: string
  created_at: string
  updated_at: string
  source: string
  merged_into?: string | null
}

export interface PersonRelation {
  id: string
  from_person_id: string
  to_person_id: string
  relation_type: PersonRelationType | string
  notes: string | null
  created_at: string
}

export interface PersonProjectLink {
  id: string
  person_id: string
  project_id: string
  role: PersonProjectRole | string
  created_at: string
}

export interface EntryEntityRaw {
  id: string
  entry_id: string
  name: string
  type: string
  payload: string
}

export interface EntityProposal {
  id: string
  entry_id: string
  kind: EntityKind
  proposal_type: ProposalType
  suggested_name: string
  suggested_meta: string
  matched_entity_id: string | null
  evidence: string | null
  status: ProposalStatus
  created_at: string
  resolved_at: string | null
}

export interface EntityLink {
  id: string
  entity_kind: EntityKind
  entity_id: string
  entry_id: string
  quantomo_id: string | null
  role: string
  created_at: string
}

export interface EmbeddingRow {
  id: string
  object_type: EmbeddingObjectType
  object_id: string
  model: string
  dims: number
  vector: string
  text_hash: string
  created_at: string
}
