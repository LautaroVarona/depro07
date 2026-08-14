import type {
  Agrupacion,
  AgrupacionGeneratedMeta,
  AgrupacionMember,
  Bookmark,
  BookmarkCounts,
  BookmarkManualTag,
  BookmarkProcessedRow,
  BookmarkQueueStatus,
  ChatBlock,
  ChatMessage,
  ChatPreview,
  ChatSession,
  ChatTipo,
  Entry,
  EntityProposalView,
  LinkHarvest,
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
  SandboxGraph,
  SandboxLink,
  SandboxLinkKind,
  SandboxNode,
  SandboxNodeKind,
  SandboxSnapshot,
  BlobNote,
  BlobTag,
  NotebookQueueStatus,
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

  ingestAudio: (
    files: File[],
    meta?: {
      batch_id?: string
      manual_tags?: BookmarkManualTag[]
      operator_note?: string
    },
  ) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    if (meta?.batch_id) form.append('batch_id', meta.batch_id)
    if (meta?.manual_tags) form.append('manual_tags', JSON.stringify(meta.manual_tags))
    if (meta?.operator_note) form.append('operator_note', meta.operator_note)
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
  ingestAudioOne: (
    file: File,
    meta?: {
      batch_id?: string
      manual_tags?: BookmarkManualTag[]
      operator_note?: string
    },
  ) => {
    const form = new FormData()
    form.append('files', file)
    if (meta?.batch_id) form.append('batch_id', meta.batch_id)
    if (meta?.manual_tags) form.append('manual_tags', JSON.stringify(meta.manual_tags))
    if (meta?.operator_note) form.append('operator_note', meta.operator_note)
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

  ingestBlob: (body: {
    text: string
    timestamp_exact: string
    tags: BlobTag[]
  }) =>
    request<{ ok: boolean; blob: BlobNote }>('/api/ingest/blob', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listBlobs: (limit?: number) => {
    const qs = new URLSearchParams()
    if (limit != null) qs.set('limit', String(limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<{ blobs: BlobNote[] }>(`/api/entries/blobs${suffix}`)
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

  getCribaAudios: () => request<{ entries: Entry[] }>('/api/entries/criba'),

  getPendingProposals: () =>
    request<{ proposals: ProposalBundle[] }>('/api/proposals/pending'),

  patchAudioCriba: (
    entryId: string,
    body: {
      content_raw?: string
      operator_note?: string
      manual_tags?: BookmarkManualTag[]
      speaker_map?: Array<{
        speaker: number
        person_id: string | null
        person_name: string | null
      }>
    },
  ) =>
    request<{ ok: boolean; entry: Entry }>(
      `/api/entries/${encodeURIComponent(entryId)}/criba`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),

  voteAudioCriba: (
    entryId: string,
    weight: number,
    body?: {
      content_raw?: string
      operator_note?: string
      manual_tags?: BookmarkManualTag[]
      speaker_map?: Array<{
        speaker: number
        person_id: string | null
        person_name: string | null
      }>
    },
  ) =>
    request<{ ok: boolean; entry: Entry }>(
      `/api/entries/${encodeURIComponent(entryId)}/weight`,
      {
        method: 'POST',
        body: JSON.stringify({ weight, ...body }),
      },
    ),

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
      pending_proposals_count?: number
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

  searchPersons: (q: string, opts?: { mode?: 'lexical' | 'semantic' | 'hybrid'; signal?: AbortSignal }) => {
    const qs = new URLSearchParams({ q })
    if (opts?.mode) qs.set('mode', opts.mode)
    return request<{
      query: string
      results: Array<{
        id: string
        name: string
        kind: PersonKind
        aliases_list: string[]
        is_operator?: boolean
        score: number
      }>
    }>(`/api/persons/search?${qs}`, { signal: opts?.signal })
  },

  typeaheadEntities: (
    q: string,
    opts?: {
      kinds?: Array<'person' | 'project' | 'quantomo' | 'agrupacion'>
      limit?: number
      scope?: 'masters' | 'all'
      signal?: AbortSignal
    },
  ) => {
    const qs = new URLSearchParams({ q })
    if (opts?.kinds?.length) qs.set('kinds', opts.kinds.join(','))
    if (opts?.limit != null) qs.set('limit', String(opts.limit))
    if (opts?.scope) qs.set('scope', opts.scope)
    return request<{
      query: string
      results: Array<{
        kind: 'person' | 'project' | 'quantomo' | 'agrupacion'
        id: string
        label: string
        subtitle: string
        aliases: string[]
        score: number
      }>
    }>(`/api/entities/typeahead?${qs}`, { signal: opts?.signal })
  },

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

  // —— Agrupaciones ——
  listAgrupaciones: () =>
    request<{ agrupaciones: Agrupacion[] }>('/api/agrupaciones'),

  getAgrupacion: (id: string) =>
    request<{ agrupacion: Agrupacion; members: AgrupacionMember[] }>(
      `/api/agrupaciones/${id}`,
    ),

  listAgrupacionesByPerson: (personId: string) =>
    request<{ agrupaciones: Agrupacion[] }>(
      `/api/agrupaciones/by-person/${personId}`,
    ),

  createAgrupacion: (body: { name: string; notes?: string }) =>
    request<{ ok: boolean; agrupacion: Agrupacion }>('/api/agrupaciones', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateAgrupacion: (
    id: string,
    body: { name?: string; notes?: string },
  ) =>
    request<{ ok: boolean; agrupacion: Agrupacion }>(
      `/api/agrupaciones/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
    ),

  deleteAgrupacion: (id: string) =>
    request<{ ok: boolean; id: string }>(`/api/agrupaciones/${id}`, {
      method: 'DELETE',
    }),

  addAgrupacionMember: (agrupacionId: string, personId: string) =>
    request<{ ok: boolean; member: AgrupacionMember }>(
      `/api/agrupaciones/${agrupacionId}/members`,
      {
        method: 'POST',
        body: JSON.stringify({ person_id: personId }),
      },
    ),

  removeAgrupacionMember: (agrupacionId: string, personId: string) =>
    request<{ ok: boolean; id: string; person_id: string }>(
      `/api/agrupaciones/${agrupacionId}/members/${personId}`,
      { method: 'DELETE' },
    ),

  processAgrupacionMeta: (id: string) =>
    request<{
      ok: boolean
      agrupacion: Agrupacion
      members: AgrupacionMember[]
      generated_meta: AgrupacionGeneratedMeta
    }>(`/api/agrupaciones/${id}/process`, { method: 'POST' }),

  // —— Proyectos ——
  listProjects: () =>
    request<{
      projects: Project[]
      profiles: Project[]
      waiting: Project[]
      waiting_count: number
      profile_count: number
      pending_proposals_count?: number
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

  searchProjects: (q: string, opts?: { mode?: 'lexical' | 'semantic' | 'hybrid'; signal?: AbortSignal }) => {
    const qs = new URLSearchParams({ q })
    if (opts?.mode) qs.set('mode', opts.mode)
    return request<{
      query: string
      results: Array<{
        id: string
        title: string
        category: ProjectKind
        aliases_list: string[]
        score: number
      }>
    }>(`/api/projects/search?${qs}`, { signal: opts?.signal })
  },

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

  searchGraphNodes: (
    q: string,
    limit = 12,
    opts?: { mode?: 'lexical' | 'semantic' | 'hybrid'; signal?: AbortSignal },
  ) => {
    const qs = new URLSearchParams({
      q,
      limit: String(limit),
    })
    if (opts?.mode) qs.set('mode', opts.mode)
    return request<{
      query: string
      results: Array<{ id: string; type: string; label: string; score: number }>
      mode?: string
    }>(`/api/graph/search?${qs}`, { signal: opts?.signal })
  },

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

  // —— Sandboxes de grafo ——
  listSandboxGraphs: () =>
    request<{ graphs: SandboxGraph[] }>('/api/sandboxes'),

  createSandboxGraph: (body: { name: string; description?: string }) =>
    request<{ graph: SandboxGraph }>('/api/sandboxes', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getSandboxSnapshot: (id: string) =>
    request<SandboxSnapshot>(`/api/sandboxes/${id}`),

  updateSandboxGraph: (
    id: string,
    body: { name?: string; description?: string },
  ) =>
    request<{ graph: SandboxGraph }>(`/api/sandboxes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteSandboxGraph: (id: string) =>
    request<{ ok: boolean }>(`/api/sandboxes/${id}`, { method: 'DELETE' }),

  addSandboxNode: (
    graphId: string,
    body: {
      kind: SandboxNodeKind
      label?: string
      ref_id?: string | null
      color?: string | null
      notes?: string
    },
  ) =>
    request<{ node: SandboxNode }>(`/api/sandboxes/${graphId}/nodes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteSandboxNode: (graphId: string, nodeId: string) =>
    request<{ ok: boolean }>(`/api/sandboxes/${graphId}/nodes/${nodeId}`, {
      method: 'DELETE',
    }),

  addSandboxLink: (
    graphId: string,
    body: {
      source_node_id: string
      target_node_id: string
      kind?: SandboxLinkKind
      label?: string
      quantomo_id?: string | null
    },
  ) =>
    request<{ link: SandboxLink }>(`/api/sandboxes/${graphId}/links`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteSandboxLink: (graphId: string, linkId: string) =>
    request<{ ok: boolean }>(`/api/sandboxes/${graphId}/links/${linkId}`, {
      method: 'DELETE',
    }),

  promoteSandboxLink: (graphId: string, linkId: string) =>
    request<{
      ok: boolean
      already: boolean
      person_project_link_id: string | null
      link: SandboxLink
    }>(`/api/sandboxes/${graphId}/links/${linkId}/promote`, {
      method: 'POST',
      body: JSON.stringify({}),
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

  // —— Bookmarks / Criba ——
  getBookmarkStats: (source: 'all' | 'twitter' | 'instagram' = 'all') =>
    request<{ ok: boolean; counts: BookmarkCounts; source?: string }>(
      `/api/bookmarks/stats?source=${source}`,
    ),

  getPendingBookmarks: (
    limit = 20,
    order: 'asc' | 'desc' | 'random' = 'asc',
    source: 'all' | 'twitter' | 'instagram' = 'all',
  ) =>
    request<{
      ok: boolean
      pending: Bookmark[]
      order: 'asc' | 'desc' | 'random'
      counts: BookmarkCounts
      source?: string
    }>(
      `/api/bookmarks/pending?limit=${limit}&order=${order}&source=${source}`,
    ),

  getProcessedBookmarks: (
    limit = 200,
    opts?: {
      minWeight?: number
      maxWeight?: number
      source?: 'all' | 'twitter' | 'instagram'
      approval?: 'pending' | 'approved' | 'all'
    },
  ) => {
    const min = opts?.minWeight ?? 1
    const max = opts?.maxWeight ?? 12
    const source = opts?.source ?? 'all'
    const approval = opts?.approval ?? 'all'
    return request<{
      ok: boolean
      processed: BookmarkProcessedRow[]
      filter: {
        min_weight: number
        max_weight: number
        approval: string
      }
      source?: string
      counts: BookmarkCounts
    }>(
      `/api/bookmarks/processed?limit=${limit}&min=${min}&max=${max}&source=${source}&approval=${approval}`,
    )
  },

  getScoredBookmarks: (
    limit = 200,
    opts?: {
      minWeight?: number
      maxWeight?: number
      source?: 'all' | 'twitter' | 'instagram'
      /** `cribado` = solo validados aún sin IA */
      status?: 'cribado' | 'all'
    },
  ) => {
    const min = opts?.minWeight ?? 1
    const max = opts?.maxWeight ?? 12
    const source = opts?.source ?? 'all'
    const status = opts?.status ?? 'all'
    return request<{
      ok: boolean
      scored: Bookmark[]
      filter: { min_weight: number; max_weight: number; status?: string }
      counts: BookmarkCounts
    }>(
      `/api/bookmarks/scored?limit=${limit}&min=${min}&max=${max}&source=${source}&status=${status}`,
    )
  },

  exportBookmarks: (opts?: {
    minWeight?: number
    maxWeight?: number
    source?: 'all' | 'twitter' | 'instagram'
  }) => {
    const min = opts?.minWeight ?? 1
    const max = opts?.maxWeight ?? 12
    const source = opts?.source ?? 'all'
    return request<{
      exported_at: string
      source: string
      filter: { min_weight: number; max_weight: number }
      count: number
      bookmarks: Array<Record<string, unknown>>
    }>(`/api/bookmarks/export?min=${min}&max=${max}&source=${source}`)
  },

  importBookmarksFile: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{
      ok: boolean
      imported: number
      skipped: number
      updated: number
      detected_source?: 'twitter' | 'instagram' | 'mixed'
      counts: BookmarkCounts
    }>('/api/bookmarks/import', { method: 'POST', body: form })
  },

  setBookmarkWeight: (id: string, weight: number) =>
    request<{
      ok: boolean
      id: string
      weight: number
      status: string
      counts: BookmarkCounts
    }>(`/api/bookmarks/${encodeURIComponent(id)}/weight`, {
      method: 'POST',
      body: JSON.stringify({ weight }),
    }),

  updateBookmarkNote: (
    id: string,
    body: {
      operator_note?: string
      manual_tags?: BookmarkManualTag[]
    },
  ) =>
    request<{
      ok: boolean
      bookmark: Bookmark
      links_applied: number
    }>(`/api/bookmarks/${encodeURIComponent(id)}/note`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  ensureBookmarkMedia: async (id: string) => {
    const res = await fetch(
      `/api/bookmarks/${encodeURIComponent(id)}/ensure-media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    )
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      id?: string
      local_media_path?: string
      media_url?: string
      error?: string
      link?: string
    }
    if (!res.ok || data.ok === false) {
      return {
        ok: false as const,
        error: data.error || `HTTP ${res.status}`,
        link: data.link,
      }
    }
    return {
      ok: true as const,
      id: data.id ?? id,
      local_media_path: data.local_media_path,
      media_url: data.media_url,
    }
  },

  bookmarkMediaUrl: (id: string) =>
    `/api/bookmarks/${encodeURIComponent(id)}/media`,

  processHighValueBookmarks: (limit = 25) =>
    request<{
      ok: boolean
      processed: number
      skipped: number
      errors: Array<{ id: string; error: string }>
      ids: string[]
      items: Array<{
        id: string
        weight: number
        category: string
        quantomo: string
        quantomo_id: string
        entry_id: string
        title: string
      }>
      counts: BookmarkCounts
    }>('/api/bookmarks/process-high-value', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  startBookmarkProcess: (limit = 5000) =>
    request<
      BookmarkQueueStatus & {
        ok: boolean
        queued: number
        message: string
        counts: BookmarkCounts
      }
    >('/api/bookmarks/process/start', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  stopBookmarkProcess: () =>
    request<
      BookmarkQueueStatus & { ok: boolean; counts: BookmarkCounts }
    >('/api/bookmarks/process/stop', { method: 'POST', body: '{}' }),

  getBookmarkProcessStatus: () =>
    request<BookmarkQueueStatus & { ok: boolean; counts: BookmarkCounts }>(
      '/api/bookmarks/process/status',
    ),

  getPendingBookmarkQuantomos: (limit = 200) =>
    request<{
      ok: boolean
      pending: Array<{
        bookmark_id: string
        quantomo_id: string
        entry_id: string
        weight: number | null
        category: string | null
        title: string
        content: string | null
        hermetic_weight: number | null
        human_weight: number | null
        suggested_weight: number | null
        author_username: string | null
        link: string | null
        text: string
      }>
      counts: BookmarkCounts
    }>(`/api/bookmarks/pending-quantomos?limit=${limit}`),

  approveBookmarkQuantomos: (ids?: string[]) =>
    request<{
      ok: boolean
      approved: number
      entryIds: string[]
      counts: BookmarkCounts
    }>('/api/bookmarks/approve-quantomos', {
      method: 'POST',
      body: JSON.stringify(ids ? { ids } : {}),
    }),

  getBookmarkMediaDeps: () =>
    request<{
      ok: boolean
      ffmpeg_ok: boolean
      ocr_pending: number
      counts: BookmarkCounts
    }>('/api/bookmarks/media-deps'),

  reprocessBookmarkOcr: (id: string) =>
    request<{
      ok: boolean
      item: {
        id: string
        ocr_frame_count: number
        video_meta: string | null
        audio_summary: string | null
        title: string
        quantomo: string
        category: string
      }
      ffmpeg_ok: boolean
      counts: BookmarkCounts
    }>(`/api/bookmarks/${encodeURIComponent(id)}/reprocess-ocr`, {
      method: 'POST',
      body: '{}',
    }),

  reprocessBookmarkOcrBatch: (opts?: { ids?: string[]; limit?: number }) =>
    request<{
      ok: boolean
      processed: number
      skipped: number
      errors: Array<{ id: string; error: string }>
      items: Array<{
        id: string
        ocr_frame_count: number
        title: string
        quantomo: string
      }>
      ffmpeg_ok: boolean
      ocr_pending: number
      counts: BookmarkCounts
    }>('/api/bookmarks/reprocess-ocr', {
      method: 'POST',
      body: JSON.stringify({
        ids: opts?.ids,
        limit: opts?.limit ?? 25,
      }),
    }),

  // —— Cuadernos ——
  listNotebooks: () =>
    request<{ notebooks: import('../types').Notebook[] }>('/api/notebooks'),

  createNotebook: (title: string, kind: 'fisico' | 'digital') =>
    request<{ notebook: import('../types').Notebook }>('/api/notebooks', {
      method: 'POST',
      body: JSON.stringify({ title, kind }),
    }),

  getNotebook: (id: string) =>
    request<{
      notebook: import('../types').Notebook
      pages: import('../types').NotebookPage[]
      index: import('../types').NotebookIndexEntry[]
      summary: {
        total: number
        vacias: number
        pendiente_vision: number
        pendiente_validacion: number
        validadas?: number
        procesadas: number
        with_image: number
      }
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}`),

  updateNotebook: (
    id: string,
    patch: { title?: string; cover_url?: string | null },
  ) =>
    request<{ notebook: import('../types').Notebook }>(
      `/api/notebooks/${id}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  deleteNotebook: (id: string) =>
    request<{
      ok: boolean
      id: string
      deleted_pages: number
      deleted_entries: number
    }>(`/api/notebooks/${id}`, { method: 'DELETE' }),

  ingestNotebookPdf: (id: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{
      ok: boolean
      notebook_id: string
      pages_imported: number
      pages_blank: number
      pages_truncated: number
      vision_queued: number
      pending_ocr?: number
      warning?: string
    }>(`/api/notebooks/${id}/ingest-pdf`, { method: 'POST', body: form })
  },

  ingestNotebookImages: (
    id: string,
    files: File[],
    opts?: { mode?: 'append' | 'from_slot'; startSlot?: number },
  ) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    form.append('mode', opts?.mode ?? 'append')
    if (opts?.startSlot != null) {
      form.append('start_slot', String(opts.startSlot))
    }
    return request<{
      ok: boolean
      notebook_id: string
      pages_imported: number
      pages_blank: number
      slots_assigned: number[]
      vision_queued: number
      pending_ocr?: number
      warning?: string
    }>(`/api/notebooks/${id}/ingest-images`, { method: 'POST', body: form })
  },

  getNotebookPage: (id: string, slot: number) =>
    request<{
      page: import('../types').NotebookPage
      label: string
    }>(`/api/notebooks/${id}/pages/${slot}`),

  patchNotebookPage: (
    id: string,
    slot: number,
    patch: {
      title?: string
      transcription_spatial?: string
      graphic_elements?: import('../types').GraphicElement[] | string
      is_blank?: boolean
      status?: string
      numero_logico?: number
      posicion_visual?: string
      explanation?: string
      mentioned_entities?: import('../types').BlobTag[]
    },
  ) =>
    request<{ page: import('../types').NotebookPage }>(
      `/api/notebooks/${id}/pages/${slot}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  reprocessNotebookPageVision: (id: string, slot: number) =>
    request<{
      ok: boolean
      queued: boolean
      vision_queue: { running: boolean; pending: number }
    }>(`/api/notebooks/${id}/pages/${slot}/reprocess-vision`, {
      method: 'POST',
    }),

  replaceNotebookPageImage: (
    id: string,
    slot: number,
    image_base64: string,
    reprocess = true,
  ) =>
    request<{
      ok: boolean
      page: import('../types').NotebookPage
      vision_queued: boolean
      vision_queue: { running: boolean; pending: number }
    }>(`/api/notebooks/${id}/pages/${slot}/image`, {
      method: 'PUT',
      body: JSON.stringify({ image_base64, reprocess }),
    }),

  transformNotebookPageImage: (
    id: string,
    slot: number,
    body: {
      rotate?: 0 | 90 | 180 | 270
      crop?: [number, number, number, number] | null
      reprocess?: boolean
    },
  ) =>
    request<{
      ok: boolean
      page: import('../types').NotebookPage
      vision_queued: boolean
      vision_queue: { running: boolean; pending: number }
    }>(`/api/notebooks/${id}/pages/${slot}/transform`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  splitNotebookSpread: (id: string, slot: number) =>
    request<{
      ok: boolean
      left_slot: number
      right_slot: number
      left: import('../types').NotebookPage
      right: import('../types').NotebookPage
      vision_queue: { running: boolean; pending: number }
    }>(`/api/notebooks/${id}/pages/${slot}/split-spread`, {
      method: 'POST',
    }),

  confirmNotebookPage: (id: string, slot: number) =>
    request<{
      ok: boolean
      queued: boolean
      already: boolean
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}/pages/${slot}/confirm`, { method: 'POST' }),

  approveNotebookTranscription: (id: string, slot: number) =>
    request<{
      ok: boolean
      page: import('../types').NotebookPage
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}/pages/${slot}/approve-transcription`, {
      method: 'POST',
    }),

  fullReadNotebook: (id: string) =>
    request<{
      ok: boolean
      vision_queued: number
      confirm_queued: number
      skipped: number
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}/full-read`, { method: 'POST' }),

  processNotebookOcr: (id: string) =>
    request<{
      ok: boolean
      vision_queued: number
      confirm_queued: number
      skipped: number
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}/process-ocr`, { method: 'POST' }),

  generateNotebookExplanations: (id: string) =>
    request<{
      ok: boolean
      queued: number
      skipped: number
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}/generate-explanations`, { method: 'POST' }),

  sendNotebookToCorpus: (id: string) =>
    request<{
      ok: boolean
      queued: number
      skipped: number
      vision_queue: NotebookQueueStatus
    }>(`/api/notebooks/${id}/send-to-corpus`, { method: 'POST' }),

  saveNotebookCanvas: (
    id: string,
    slot: number,
    body: {
      image_base64?: string
      title?: string
      transcription_spatial?: string
      graphic_elements?: import('../types').GraphicElement[]
      run_vision?: boolean
    },
  ) =>
    request<{
      page: import('../types').NotebookPage
      vision_queue: { running: boolean; pending: number }
    }>(`/api/notebooks/${id}/pages/${slot}/canvas`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  notebookPageImageUrl: (id: string, slot: number) =>
    `/api/notebooks/${id}/pages/${slot}/image`,

  previewChat: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ ok: boolean; preview: ChatPreview }>(
      '/api/chats/preview',
      { method: 'POST', body: form },
    )
  },

  importChat: (input: {
    file: File
    nombre_chat?: string
    tipo?: ChatTipo
    person_ids?: string[]
  }) => {
    const form = new FormData()
    form.append('file', input.file)
    if (input.nombre_chat) form.append('nombre_chat', input.nombre_chat)
    if (input.tipo) form.append('tipo', input.tipo)
    if (input.person_ids?.length) {
      form.append('person_ids', JSON.stringify(input.person_ids))
    }
    return request<{
      ok: boolean
      session: ChatSession
      message_count: number
      block_count: number
      link_count: number
    }>('/api/chats/import', { method: 'POST', body: form })
  },

  listChats: () =>
    request<{ ok: boolean; sessions: ChatSession[] }>('/api/chats'),

  getChat: (id: string) =>
    request<{
      ok: boolean
      session: ChatSession
      blocks: ChatBlock[]
      messages_sample: ChatMessage[]
      stats: {
        message_count: number
        system_count: number
        media_count: number
        link_count: number
        pending_blocks: number
      }
    }>(`/api/chats/${id}`),

  processChat: (id: string, limit = 2) =>
    request<{
      ok: boolean
      processed: number
      skipped: number
      remaining: number
      errors: Array<{ block_id: string; error: string }>
      items: Array<{
        block_id: string
        entry_id: string
        quantomo_id: string
        title: string
      }>
    }>(`/api/chats/${id}/process`, {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),

  listLinks: (opts?: {
    q?: string
    estado?: string
    source_type?: string
    limit?: number
  }) => {
    const params = new URLSearchParams()
    if (opts?.q) params.set('q', opts.q)
    if (opts?.estado) params.set('estado', opts.estado)
    if (opts?.source_type) params.set('source_type', opts.source_type)
    if (opts?.limit != null) params.set('limit', String(opts.limit))
    const qs = params.toString()
    return request<{ ok: boolean; links: LinkHarvest[]; total: number }>(
      `/api/links${qs ? `?${qs}` : ''}`,
    )
  },

  backfillLinks: () =>
    request<{ ok: boolean; scanned: number; inserted: number }>(
      '/api/links/backfill',
      { method: 'POST', body: JSON.stringify({}) },
    ),

  backupSummary: () =>
    request<{
      ok: boolean
      exported_at: string
      include_media: false
      tables: Record<string, number>
      groups: {
        transcripciones: number
        perfiles: number
        conexiones: number
        quantomos: number
        validaciones: number
        resto: number
      }
    }>('/api/backup/summary'),

  sendFeedback: (opts: {
    body: string
    viewId: string
    context: Record<string, unknown>
    logs: unknown[]
    images: File[]
  }) => {
    const form = new FormData()
    form.append('body', opts.body)
    form.append('view_id', opts.viewId)
    form.append('context_json', JSON.stringify(opts.context))
    form.append('logs_json', JSON.stringify(opts.logs))
    for (const img of opts.images) form.append('images', img)
    return request<{ ok: true; id: string; folder: string; images: number }>(
      '/api/feedback',
      { method: 'POST', body: form },
    )
  },

  restoreBackup: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ ok: true; tables: Record<string, number> }>(
      '/api/backup/restore',
      { method: 'POST', body: form },
    )
  },
}

export type { Entry, ProposalBundle, Person, Project, EntityProposalView }
