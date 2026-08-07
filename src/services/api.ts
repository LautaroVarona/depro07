import type {
  Entry,
  EntityProposalView,
  Person,
  PersonKind,
  Project,
  ProjectStatus,
  ProposalBundle,
  EntityLink,
  PersonRelation,
  PersonProjectLink,
  PersonRelationType,
  PersonProjectRole,
  ProjectKind,
  Quantomo,
  GraphLinkSuggestion,
  GraphSnapshot,
} from '../types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const err = (await res.json()) as { error?: string }
      if (err.error) message = err.error
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }

  return (await res.json()) as T
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),

  ingestAudio: (files: File[]) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    return request<{
      ok: boolean
      entries: Array<{
        id: string
        title: string
        title_manual: number
        timestamp_exact: string
        origin_source: string
        status: string
      }>
    }>('/api/ingest/audio', { method: 'POST', body: form })
  },

  /** Sube un archivo a la vez (recomendado para m4a grandes). */
  ingestAudioOne: (file: File) => {
    const form = new FormData()
    form.append('files', file)
    return request<{
      ok: boolean
      entries: Array<{
        id: string
        title: string
        title_manual: number
        timestamp_exact: string
        origin_source: string
        status: string
      }>
    }>('/api/ingest/audio', { method: 'POST', body: form })
  },

  getQueued: () => request<{ entries: Entry[] }>('/api/entries/queued'),

  getValidated: () =>
    request<{ entries: ProposalBundle[] }>('/api/entries/validated'),

  runPipeline: (entryIds?: string[]) =>
    request<{
      ok: boolean
      running: boolean
      paused?: boolean
      accepted: string[]
      message: string
    }>('/api/pipeline/run', {
      method: 'POST',
      body: JSON.stringify({ entryIds }),
    }),

  getPipelineStatus: () =>
    request<{
      running: boolean
      paused: boolean
      queued: number
      remaining: number
      currentEntryId: string | null
      currentTitle: string | null
      stage: string
      stageLabel: string
      transcript: string
      stub: boolean
      chunk: number | null
      totalChunks: number | null
    }>('/api/pipeline/status'),

  pausePipeline: () =>
    request<{
      ok: boolean
      paused: boolean
      cleared: number
      resetProcessing: number
      message: string
    }>('/api/pipeline/pause', { method: 'POST', body: JSON.stringify({}) }),

  resumePipeline: () =>
    request<{
      ok: boolean
      paused: boolean
      message: string
    }>('/api/pipeline/resume', { method: 'POST', body: JSON.stringify({}) }),

  clearQueuedEntries: () =>
    request<{ ok: boolean; deleted: number }>('/api/entries/queued', {
      method: 'DELETE',
    }),

  getPendingProposals: () =>
    request<{ proposals: ProposalBundle[] }>('/api/proposals/pending'),

  approve: (
    entryId: string,
    opts?: {
      title?: string
      rejectQuantomoIds?: string[]
      rejectTaskIds?: string[]
      quantomos?: Array<{ id: string; title: string; content: string }>
      tasks?: Array<{ id: string; task_text: string; tag: string }>
    },
  ) =>
    request<{ ok: boolean; entity_proposals?: number }>(
      '/api/proposals/approve',
      {
        method: 'POST',
        body: JSON.stringify({ entryId, ...opts }),
      },
    ),

  reject: (entryId: string) =>
    request<{ ok: boolean }>('/api/proposals/reject', {
      method: 'POST',
      body: JSON.stringify({ entryId }),
    }),

  updateTimestamp: (entryId: string, timestamp_exact: string) =>
    request<{ ok: boolean; entry: Entry }>('/api/entries/timestamp', {
      method: 'PATCH',
      body: JSON.stringify({ entryId, timestamp_exact }),
    }),

  updateTitle: (entryId: string, title: string) =>
    request<{ ok: boolean; entry: Entry }>('/api/entries/title', {
      method: 'PATCH',
      body: JSON.stringify({ entryId, title }),
    }),

  deleteEntry: (entryId: string) =>
    request<{ ok: boolean; entryId: string }>(`/api/entries/${entryId}`, {
      method: 'DELETE',
    }),

  // —— Personas ——
  listPersons: () =>
    request<{
      persons: Person[]
      profiles: Person[]
      waiting: Person[]
      waiting_count: number
      profile_count: number
      operator_id: string | null
    }>('/api/persons'),

  getPerson: (id: string) =>
    request<{
      person: Person
      links: EntityLink[]
      relations: PersonRelation[]
      project_links: PersonProjectLink[]
      operator_id: string | null
    }>(`/api/persons/${id}`),

  exportPersons: () =>
    request<{
      exported_at: string
      source: string
      count: number
      profiles: unknown[]
    }>('/api/persons/export'),

  searchPersons: (q: string) =>
    request<{
      query: string
      results: Array<{
        id: string
        name: string
        kind: PersonKind
        aliases_list: string[]
        is_operator?: boolean
        score: number
      }>
    }>(`/api/persons/search?q=${encodeURIComponent(q)}`),

  createPerson: (body: {
    name: string
    kind?: PersonKind
    aliases?: string[] | string
    notes?: string
  }) =>
    request<{ ok: boolean; person: Person }>('/api/persons', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updatePerson: (
    id: string,
    body: {
      name?: string
      kind?: PersonKind
      aliases?: string[] | string
      notes?: string
      status?: string
    },
  ) =>
    request<{ ok: boolean; person: Person }>(`/api/persons/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deletePerson: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/persons/${id}`, {
      method: 'DELETE',
    }),

  setPersonOperator: (id: string, enable = true) =>
    request<{ ok: boolean; operator_id: string | null; person_id: string }>(
      `/api/persons/${id}/operator`,
      {
        method: 'POST',
        body: JSON.stringify({ enable }),
      },
    ),

  createPersonRelation: (
    fromId: string,
    body: {
      to_person_id?: string
      to_operator?: boolean
      relation_type?: PersonRelationType
      notes?: string
    },
  ) =>
    request<{ ok: boolean; relation: PersonRelation }>(
      `/api/persons/${fromId}/relations`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  deletePersonRelation: (relationId: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/persons/relations/${relationId}`,
      { method: 'DELETE' },
    ),

  linkPersonToProject: (
    personId: string,
    body: { project_id: string; role?: PersonProjectRole },
  ) =>
    request<{ ok: boolean; link: PersonProjectLink }>(
      `/api/persons/${personId}/projects`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),

  unlinkPersonFromProject: (linkId: string) =>
    request<{ ok: boolean; id: string }>(
      `/api/persons/project-links/${linkId}`,
      { method: 'DELETE' },
    ),

  attachWaitingToProfile: (waitingId: string, masterId: string) =>
    request<{
      ok: boolean
      master_id: string
      waiting_id: string
      alias_added?: string
      aliases?: string[]
    }>(`/api/persons/${waitingId}/attach`, {
      method: 'POST',
      body: JSON.stringify({ master_id: masterId }),
    }),

  promoteToProfile: (
    id: string,
    body?: {
      name?: string
      kind?: PersonKind
      aliases?: string[] | string
      notes?: string
    },
  ) =>
    request<{ ok: boolean; person: Person }>(`/api/persons/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),

  getPendingPersons: () =>
    request<{ proposals: EntityProposalView[] }>('/api/persons/pending'),

  approvePersonProposal: (
    id: string,
    body?: {
      name?: string
      kind?: PersonKind
      aliases?: string[] | string
      notes?: string
      matched_entity_id?: string
      as?: 'create' | 'link'
    },
  ) =>
    request<{
      ok: boolean
      person_id?: string
      link_id?: string
      discarded?: boolean
      mode?: string
    }>(`/api/persons/proposals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),

  rejectPersonProposal: (id: string, reason?: string) =>
    request<{ ok: boolean }>(`/api/persons/proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // —— Proyectos ——
  listProjects: () =>
    request<{
      projects: Project[]
      profiles: Project[]
      waiting: Project[]
      waiting_count: number
      profile_count: number
    }>('/api/projects'),

  getProject: (id: string) =>
    request<{
      project: Project
      links: EntityLink[]
      people: PersonProjectLink[]
    }>(`/api/projects/${id}`),

  exportProjects: () =>
    request<{
      exported_at: string
      source: string
      count: number
      projects: unknown[]
    }>('/api/projects/export'),

  searchProjects: (q: string) =>
    request<{
      query: string
      results: Array<{
        id: string
        title: string
        category: ProjectKind
        aliases_list: string[]
        score: number
      }>
    }>(`/api/projects/search?q=${encodeURIComponent(q)}`),

  createProject: (body: {
    title: string
    category?: ProjectKind | string
    status?: ProjectStatus
    tactical_focus?: string
    notes?: string
    aliases?: string[] | string
  }) =>
    request<{ ok: boolean; project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateProject: (
    id: string,
    body: {
      title?: string
      category?: ProjectKind | string
      status?: ProjectStatus
      tactical_focus?: string
      notes?: string
      aliases?: string[] | string
    },
  ) =>
    request<{ ok: boolean; project: Project }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteProject: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/projects/${id}`, {
      method: 'DELETE',
    }),

  attachWaitingToProject: (waitingId: string, masterId: string) =>
    request<{
      ok: boolean
      master_id: string
      waiting_id: string
      alias_added?: string
      aliases?: string[]
    }>(`/api/projects/${waitingId}/attach`, {
      method: 'POST',
      body: JSON.stringify({ master_id: masterId }),
    }),

  promoteToProject: (
    id: string,
    body?: {
      title?: string
      category?: ProjectKind | string
      status?: ProjectStatus
      tactical_focus?: string
      aliases?: string[] | string
      notes?: string
    },
  ) =>
    request<{ ok: boolean; project: Project }>(`/api/projects/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),

  getPendingProjects: () =>
    request<{ proposals: EntityProposalView[] }>('/api/projects/pending'),

  approveProjectProposal: (
    id: string,
    body?: {
      title?: string
      category?: string
      status?: ProjectStatus
      tactical_focus?: string
      notes?: string
      matched_entity_id?: string
      as?: 'create' | 'link'
    },
  ) =>
    request<{
      ok: boolean
      project_id: string
      link_id: string
      mode?: string
    }>(`/api/projects/proposals/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),

  rejectProjectProposal: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/proposals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // —— Grafo (co-ocurrencia HITL) ——
  getGraphSnapshot: (opts?: { suggestions?: boolean }) => {
    const qs = new URLSearchParams()
    if (opts?.suggestions === false) qs.set('suggestions', '0')
    const q = qs.toString()
    return request<GraphSnapshot>(`/api/graph${q ? `?${q}` : ''}`)
  },

  searchGraphNodes: (q: string, limit = 12) =>
    request<{
      query: string
      results: Array<{ id: string; type: string; label: string; score: number }>
    }>(
      `/api/graph/search?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  discoverGraphLinks: (params?: {
    person_id?: string
    project_id?: string
    limit?: number
  }) => {
    const qs = new URLSearchParams()
    if (params?.person_id) qs.set('person_id', params.person_id)
    if (params?.project_id) qs.set('project_id', params.project_id)
    if (params?.limit != null) qs.set('limit', String(params.limit))
    const q = qs.toString()
    return request<{
      suggestions: GraphLinkSuggestion[]
      count: number
    }>(`/api/graph/discover${q ? `?${q}` : ''}`)
  },

  approveGraphLinkHitl: (body: {
    person_id: string
    project_id: string
    role?: PersonProjectRole | string
    alias?: string
    alias_target?: 'person' | 'project'
  }) =>
    request<{
      ok: boolean
      link: PersonProjectLink
      alias_added?: string
      aliases?: string[]
    }>('/api/graph/link-hitl', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  dismissGraphLinkSuggestion: (body: {
    person_id: string
    project_id: string
  }) =>
    request<{
      ok: boolean
      person_id: string
      project_id: string
      created: boolean
    }>('/api/graph/dismiss', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // —— Quántomos ——
  listQuantomos: () =>
    request<{
      count: number
      avg_weight: number | null
      universes: Array<{ name: string; count: number }>
      quantomos: Array<
        Quantomo & {
          entry_title: string
          entry_status: string
          timestamp_exact: string | null
          original_filename: string | null
          entry_created_at: string
        }
      >
    }>('/api/quantomos'),

  getQuantomo: (id: string) =>
    request<{
      quantomo: Quantomo & {
        entry_title: string
        entry_status: string
        timestamp_exact: string | null
        original_filename: string | null
        entry_created_at: string
      }
      siblings: Array<
        Pick<Quantomo, 'id' | 'title' | 'hermetic_weight' | 'universe'>
      >
    }>(`/api/quantomos/${id}`),
}

export type { Entry, ProposalBundle, Person, Project, EntityProposalView }
