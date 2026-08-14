import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import type {
  Agrupacion,
  AgrupacionGeneratedMeta,
  AgrupacionMember,
  EntityLink,
  EntityProposalView,
  Person,
  PersonKind,
  PersonProjectLink,
  PersonProjectRole,
  PersonRelation,
  PersonRelationType,
  Project,
  ProjectKind,
} from '../types'
import { downloadJson } from '../utils/downloadJson'
import { SuggestedLinksTray } from './SuggestedLinksTray'
import { NerValidationDeck } from './NerValidationDeck'

interface Props {
  refreshKey: number
  onChanged?: () => void
  /** Controlado por EntityHub: perfiles | agrupaciones */
  mode?: 'perfiles' | 'agrupaciones'
  /** Sin wrapper entity-stage ni switch de modo (lo pone EntityHub) */
  embedded?: boolean
}

const PROFILE_KINDS: PersonKind[] = ['fisica', 'juridica', 'ficticia']

const KIND_LABEL: Record<string, string> = {
  fisica: 'Física',
  juridica: 'Jurídica',
  ficticia: 'Ficticia',
  abstracta: 'Abstracta',
  ruido: 'Ruido',
  agrupacion: 'Ficticia',
}

const RELATION_LABEL: Record<PersonRelationType, string> = {
  vinculo: 'Vínculo',
  colabora: 'Colabora',
  familia: 'Familia',
  conoce: 'Conoce',
  depende: 'Depende',
}

const ROLE_LABEL: Record<PersonProjectRole, string> = {
  responsable: 'Responsable',
  miembro: 'Miembro',
  participante: 'Participante',
  interesado: 'Interesado',
  co_mentioned: 'Co-mencionado',
}

const PROJECT_KIND_LABEL: Record<ProjectKind, string> = {
  proyecto: 'Proyecto',
  tarea: 'Tarea',
  concepto: 'Concepto',
}

function normalizeKind(k: unknown): PersonKind {
  const s = String(k ?? 'fisica').toLowerCase()
  if (s === 'agrupacion' || s === 'ficticio') return 'ficticia'
  if (
    ['fisica', 'juridica', 'ficticia', 'abstracta', 'ruido'].includes(s)
  ) {
    return s as PersonKind
  }
  return 'fisica'
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}

export function PersonsSection({
  refreshKey,
  onChanged,
  mode: modeProp,
  embedded = false,
}: Props) {
  const [profiles, setProfiles] = useState<Person[]>([])
  const [waiting, setWaiting] = useState<Person[]>([])
  const [proposals, setProposals] = useState<EntityProposalView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [links, setLinks] = useState<EntityLink[]>([])
  const [relations, setRelations] = useState<PersonRelation[]>([])
  const [projectLinks, setProjectLinks] = useState<PersonProjectLink[]>([])
  const [allProjects, setAllProjects] = useState<Project[]>([])
  const [operatorId, setOperatorId] = useState<string | null>(null)
  const [kindFilter, setKindFilter] = useState<PersonKind | 'all'>('all')
  const [relTargetId, setRelTargetId] = useState('')
  const [relType, setRelType] = useState<PersonRelationType>('vinculo')
  const [projTargetId, setProjTargetId] = useState('')
  const [projRole, setProjRole] = useState<PersonProjectRole>('miembro')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [waitingOpen, setWaitingOpen] = useState(true)
  const [validatorOpen, setValidatorOpen] = useState(false)
  const [deckOpen, setDeckOpen] = useState(false)

  const [formName, setFormName] = useState('')
  const [formKind, setFormKind] = useState<PersonKind>('fisica')
  const [formAliases, setFormAliases] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const [draftNames, setDraftNames] = useState<Record<string, string>>({})
  const [draftKinds, setDraftKinds] = useState<Record<string, PersonKind>>({})
  const [linkPick, setLinkPick] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [dragWaitingIds, setDragWaitingIds] = useState<string[]>([])
  const [selectedWaitingIds, setSelectedWaitingIds] = useState<string[]>([])
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [semanticQuery, setSemanticQuery] = useState('')
  const [semanticIds, setSemanticIds] = useState<string[] | null>(null)
  const [semanticScores, setSemanticScores] = useState<Record<string, number>>(
    {},
  )
  const [semanticBusy, setSemanticBusy] = useState(false)

  type PersonasMode = 'perfiles' | 'agrupaciones'
  const [internalMode, setInternalMode] = useState<PersonasMode>('perfiles')
  const personasMode: PersonasMode = modeProp ?? internalMode
  const setPersonasMode = (m: PersonasMode) => {
    if (modeProp === undefined) setInternalMode(m)
  }
  const [agrupaciones, setAgrupaciones] = useState<Agrupacion[]>([])
  const [selectedAgrupacionId, setSelectedAgrupacionId] = useState<string | null>(
    null,
  )
  const [agrupacionMembers, setAgrupacionMembers] = useState<
    AgrupacionMember[]
  >([])
  const [agrupacionInspectorOpen, setAgrupacionInspectorOpen] = useState(false)
  const [agrupacionEditingId, setAgrupacionEditingId] = useState<string | null>(
    null,
  )
  const [agrupFormName, setAgrupFormName] = useState('')
  const [agrupFormNotes, setAgrupFormNotes] = useState('')
  const [agrupGeneratedMeta, setAgrupGeneratedMeta] =
    useState<AgrupacionGeneratedMeta | null>(null)
  const [agrupMemberPick, setAgrupMemberPick] = useState('')
  const [agrupProcessBusy, setAgrupProcessBusy] = useState(false)
  const [personAgrupaciones, setPersonAgrupaciones] = useState<Agrupacion[]>([])
  const [addToAgrupacionId, setAddToAgrupacionId] = useState('')

  const selectedIdRef = useRef(selectedId)
  const selectedAgrupacionIdRef = useRef(selectedAgrupacionId)
  const hasLoadedRef = useRef(false)
  const proposalInFlightRef = useRef(new Set<string>())
  const loadGenRef = useRef(0)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])
  useEffect(() => {
    selectedAgrupacionIdRef.current = selectedAgrupacionId
  }, [selectedAgrupacionId])

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet ?? false
    const gen = ++loadGenRef.current
    if (!quiet) setLoading(true)
    if (!quiet) setError(null)
    try {
      const [roster, pending, projectsMap, agrupRoster] = await Promise.all([
        api.listPersons(),
        api.getPendingPersons(),
        api.listProjects(),
        api.listAgrupaciones(),
      ])
      if (gen !== loadGenRef.current) return

      const nextProfiles = roster.profiles ?? roster.persons ?? []
      setProfiles(nextProfiles)
      setWaiting(roster.waiting ?? [])
      setOperatorId(roster.operator_id ?? null)
      setAllProjects(projectsMap.projects)
      // No pisar menciones que el usuario ya resolvió y siguen in-flight
      const inFlight = proposalInFlightRef.current
      setProposals(
        pending.proposals.filter((p) => !inFlight.has(p.id)),
      )
      setAgrupaciones(agrupRoster.agrupaciones ?? [])
      setDraftNames((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) next[p.id] = p.suggested_name
        }
        return next
      })
      setDraftKinds((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) next[p.id] = normalizeKind(p.meta.kind)
        }
        return next
      })
      setLinkPick((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) {
            next[p.id] =
              p.suggested_match?.id ?? p.matched_entity_id ?? ''
          }
        }
        return next
      })
      const sid = selectedIdRef.current
      if (sid && !nextProfiles.some((p) => p.id === sid)) {
        setSelectedId(null)
        setLinks([])
        setRelations([])
        setProjectLinks([])
        setPersonAgrupaciones([])
      }
      const aid = selectedAgrupacionIdRef.current
      if (
        aid &&
        !(agrupRoster.agrupaciones ?? []).some((a) => a.id === aid)
      ) {
        setSelectedAgrupacionId(null)
        setAgrupacionMembers([])
        setAgrupacionEditingId(null)
        setAgrupacionInspectorOpen(false)
      }
    } catch (err) {
      if (gen !== loadGenRef.current) return
      setError(err instanceof Error ? err.message : 'Error al cargar')
    } finally {
      if (gen === loadGenRef.current && !quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const delay = hasLoadedRef.current ? 280 : 0
    const t = window.setTimeout(() => {
      void load({ quiet: hasLoadedRef.current })
      hasLoadedRef.current = true
    }, delay)
    return () => window.clearTimeout(t)
  }, [load, refreshKey])

  useEffect(() => {
    if (proposals.length > 0) setValidatorOpen(true)
  }, [proposals.length])

  const resolveProposal = useCallback(
    async (
      id: string,
      run: () => Promise<void>,
      successMsg?: string,
    ) => {
      if (proposalInFlightRef.current.has(id)) return
      proposalInFlightRef.current.add(id)
      setError(null)

      let snapshot: EntityProposalView | undefined
      setProposals((prev) => {
        snapshot = prev.find((p) => p.id === id)
        return prev.filter((p) => p.id !== id)
      })

      try {
        await run()
        if (successMsg) setStatus(successMsg)
        // Un solo refresh vía refreshKey (badges + roster); sin await load local
        onChanged?.()
      } catch (err) {
        if (snapshot) {
          setProposals((prev) => {
            if (prev.some((p) => p.id === snapshot!.id)) return prev
            return [snapshot!, ...prev]
          })
        }
        setError(err instanceof Error ? err.message : 'Error')
      } finally {
        proposalInFlightRef.current.delete(id)
      }
    },
    [onChanged],
  )

  const matchedWaiting = useMemo(
    () => waiting.filter((w) => w.suggested_match),
    [waiting],
  )

  const filteredProfiles = useMemo(() => {
    let list = profiles
    if (kindFilter !== 'all') {
      list = list.filter((p) => normalizeKind(p.kind) === kindFilter)
    }
    if (semanticIds) {
      const allowed = new Set(semanticIds)
      list = list.filter((p) => allowed.has(p.id))
      list = [...list].sort(
        (a, b) => (semanticScores[b.id] ?? 0) - (semanticScores[a.id] ?? 0),
      )
    }
    return list
  }, [profiles, kindFilter, semanticIds, semanticScores])

  useEffect(() => {
    const q = semanticQuery.trim()
    if (!q) {
      setSemanticIds(null)
      setSemanticScores({})
      setSemanticBusy(false)
      return
    }
    let cancelled = false
    const ac = new AbortController()
    setSemanticBusy(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await api.searchPersons(q, {
            mode: 'lexical',
            signal: ac.signal,
          })
          if (cancelled) return
          setSemanticIds(res.results.map((r) => r.id))
          const scores: Record<string, number> = {}
          for (const r of res.results) scores[r.id] = r.score
          setSemanticScores(scores)
        } catch (err) {
          if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
            return
          }
          setError(
            err instanceof Error ? err.message : 'Error en búsqueda',
          )
        } finally {
          if (!cancelled) setSemanticBusy(false)
        }
      })()
    }, 200)
    return () => {
      cancelled = true
      ac.abort()
      window.clearTimeout(timer)
    }
  }, [semanticQuery])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedWaitingIds([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Limpia selección si salen de la sala
  useEffect(() => {
    const alive = new Set(waiting.map((w) => w.id))
    setSelectedWaitingIds((prev) => prev.filter((id) => alive.has(id)))
  }, [waiting])

  const selectProfile = async (id: string) => {
    setSelectedId(id)
    setPromoteId(null)
    setInspectorOpen(true)
    setStatus(null)
    setRelTargetId('')
    setProjTargetId('')
    setAddToAgrupacionId('')
    try {
      const [data, backlinks] = await Promise.all([
        api.getPerson(id),
        api.listAgrupacionesByPerson(id),
      ])
      setLinks(data.links)
      setRelations(data.relations ?? [])
      setProjectLinks(data.project_links ?? [])
      setOperatorId(data.operator_id ?? null)
      setPersonAgrupaciones(backlinks.agrupaciones ?? [])
      setEditingId(id)
      setFormName(data.person.name)
      setFormKind(normalizeKind(data.person.kind))
      setFormAliases((data.person.aliases_list ?? []).join(', '))
      setFormNotes(data.person.notes ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al abrir ficha')
    }
  }

  const resetForm = () => {
    setEditingId(null)
    setPromoteId(null)
    setFormName('')
    setFormKind('fisica')
    setFormAliases('')
    setFormNotes('')
    setSelectedId(null)
    setLinks([])
    setRelations([])
    setProjectLinks([])
    setPersonAgrupaciones([])
    setAddToAgrupacionId('')
    setInspectorOpen(true)
  }

  const openPromote = (w: Person) => {
    setPromoteId(w.id)
    setEditingId(null)
    setSelectedId(null)
    setLinks([])
    setRelations([])
    setProjectLinks([])
    setPersonAgrupaciones([])
    setFormName(w.name)
    setFormKind(normalizeKind(w.kind))
    setFormAliases((w.aliases_list ?? []).join(', '))
    setFormNotes(w.notes ?? '')
    setInspectorOpen(true)
    setStatus(`Promover «${w.name}» a perfil maestro`)
  }

  const parseMetaFromAgrupacion = (
    a: Agrupacion,
  ): AgrupacionGeneratedMeta | null => {
    if (a.generated_meta_parsed) return a.generated_meta_parsed
    try {
      const parsed = JSON.parse(a.generated_meta || '{}') as AgrupacionGeneratedMeta
      if (!parsed || typeof parsed !== 'object') return null
      return {
        summary: String(parsed.summary ?? ''),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        themes: Array.isArray(parsed.themes) ? parsed.themes.map(String) : [],
        related_person_names: Array.isArray(parsed.related_person_names)
          ? parsed.related_person_names.map(String)
          : [],
        related_categories: Array.isArray(parsed.related_categories)
          ? parsed.related_categories.map(String)
          : [],
        inferred_facts: Array.isArray(parsed.inferred_facts)
          ? parsed.inferred_facts.map(String)
          : [],
      }
    } catch {
      return null
    }
  }

  const selectAgrupacion = async (id: string) => {
    setSelectedAgrupacionId(id)
    setAgrupacionInspectorOpen(true)
    setStatus(null)
    setAgrupMemberPick('')
    try {
      const data = await api.getAgrupacion(id)
      setAgrupacionEditingId(id)
      setAgrupFormName(data.agrupacion.name)
      setAgrupFormNotes(data.agrupacion.notes ?? '')
      setAgrupacionMembers(data.members)
      setAgrupGeneratedMeta(parseMetaFromAgrupacion(data.agrupacion))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al abrir agrupación')
    }
  }

  const resetAgrupacionForm = () => {
    setAgrupacionEditingId(null)
    setSelectedAgrupacionId(null)
    setAgrupacionMembers([])
    setAgrupFormName('')
    setAgrupFormNotes('')
    setAgrupGeneratedMeta(null)
    setAgrupMemberPick('')
    setAgrupacionInspectorOpen(true)
  }

  const handleSaveAgrupacion = async () => {
    if (!agrupFormName.trim()) return
    setStatus(null)
    try {
      if (agrupacionEditingId) {
        const res = await api.updateAgrupacion(agrupacionEditingId, {
          name: agrupFormName.trim(),
          notes: agrupFormNotes,
        })
        setStatus('Agrupación actualizada')
        setAgrupaciones((prev) =>
          prev.map((a) =>
            a.id === agrupacionEditingId ? { ...a, ...res.agrupacion } : a,
          ),
        )
      } else {
        const res = await api.createAgrupacion({
          name: agrupFormName.trim(),
          notes: agrupFormNotes,
        })
        setStatus('Agrupación creada')
        setAgrupaciones((prev) =>
          [...prev, res.agrupacion].sort((a, b) =>
            a.name.localeCompare(b.name, 'es'),
          ),
        )
        await selectAgrupacion(res.agrupacion.id)
      }
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    }
  }

  const handleDeleteAgrupacion = async () => {
    if (!agrupacionEditingId) return
    if (!window.confirm('¿Eliminar esta agrupación y sus membresías?')) return
    try {
      await api.deleteAgrupacion(agrupacionEditingId)
      setStatus('Agrupación eliminada')
      resetAgrupacionForm()
      setAgrupacionInspectorOpen(false)
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar')
    }
  }

  const handleAddAgrupacionMember = async (personId?: string) => {
    const id = personId || agrupMemberPick
    if (!agrupacionEditingId || !id) return
    try {
      await api.addAgrupacionMember(agrupacionEditingId, id)
      setAgrupMemberPick('')
      setStatus('Miembro añadido')
      await selectAgrupacion(agrupacionEditingId)
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al vincular')
    }
  }

  const handleRemoveAgrupacionMember = async (personId: string) => {
    if (!agrupacionEditingId) return
    try {
      await api.removeAgrupacionMember(agrupacionEditingId, personId)
      setStatus('Miembro quitado')
      await selectAgrupacion(agrupacionEditingId)
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al quitar')
    }
  }

  const handleProcessAgrupacion = async () => {
    if (!agrupacionEditingId) return
    setAgrupProcessBusy(true)
    setStatus(null)
    try {
      // Guardar notes antes de procesar
      await api.updateAgrupacion(agrupacionEditingId, {
        name: agrupFormName.trim() || undefined,
        notes: agrupFormNotes,
      })
      const res = await api.processAgrupacionMeta(agrupacionEditingId)
      setAgrupGeneratedMeta(res.generated_meta)
      setAgrupacionMembers(res.members)
      setStatus('Metadata generada')
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar metadata')
    } finally {
      setAgrupProcessBusy(false)
    }
  }

  const handleAddPersonToAgrupacion = async () => {
    if (!editingId || !addToAgrupacionId) return
    try {
      await api.addAgrupacionMember(addToAgrupacionId, editingId)
      setAddToAgrupacionId('')
      setStatus('Añadido a agrupación')
      const backlinks = await api.listAgrupacionesByPerson(editingId)
      setPersonAgrupaciones(backlinks.agrupaciones ?? [])
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al añadir')
    }
  }

  const handleRemovePersonFromAgrupacion = async (agrupacionId: string) => {
    if (!editingId) return
    try {
      await api.removeAgrupacionMember(agrupacionId, editingId)
      setStatus('Quitado de agrupación')
      const backlinks = await api.listAgrupacionesByPerson(editingId)
      setPersonAgrupaciones(backlinks.agrupaciones ?? [])
      onChanged?.()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al quitar')
    }
  }

  const switchPersonasMode = (mode: PersonasMode) => {
    setPersonasMode(mode)
    if (mode === 'agrupaciones') {
      setInspectorOpen(false)
      setSelectedId(null)
    } else {
      setAgrupacionInspectorOpen(false)
      setSelectedAgrupacionId(null)
    }
  }

  useEffect(() => {
    if (modeProp === undefined) return
    if (modeProp === 'agrupaciones') {
      setInspectorOpen(false)
      setSelectedId(null)
    } else {
      setAgrupacionInspectorOpen(false)
      setSelectedAgrupacionId(null)
    }
  }, [modeProp])

  const candidateMembers = useMemo(() => {
    const memberIds = new Set(agrupacionMembers.map((m) => m.person_id))
    const list: Array<Person & { _bucket: 'perfil' | 'waiting' }> = [
      ...profiles
        .filter((p) => !memberIds.has(p.id))
        .map((p) => ({ ...p, _bucket: 'perfil' as const })),
      ...waiting
        .filter((p) => !memberIds.has(p.id))
        .map((p) => ({ ...p, _bucket: 'waiting' as const })),
    ]
    return list.sort((a, b) => a.name.localeCompare(b.name, 'es'))
  }, [profiles, waiting, agrupacionMembers])

  const hasMetaContent = (meta: AgrupacionGeneratedMeta | null) => {
    if (!meta) return false
    return Boolean(
      meta.summary ||
        meta.tags.length ||
        meta.themes.length ||
        meta.related_person_names.length ||
        meta.related_categories.length ||
        meta.inferred_facts.length,
    )
  }

  const handleSave = async () => {
    if (!formName.trim()) return
    setStatus(null)
    try {
      if (promoteId) {
        await api.promoteToProfile(promoteId, {
          name: formName.trim(),
          kind: formKind,
          aliases: formAliases,
          notes: formNotes,
        })
        setStatus('Perfil promovido al directorio')
        setPromoteId(null)
        setEditingId(null)
        setInspectorOpen(false)
      } else if (editingId) {
        await api.updatePerson(editingId, {
          name: formName.trim(),
          kind: formKind,
          aliases: formAliases,
          notes: formNotes,
        })
        setStatus('Perfil actualizado')
      } else {
        await api.createPerson({
          name: formName.trim(),
          kind: formKind,
          aliases: formAliases,
          notes: formNotes,
        })
        setStatus('Perfil creado')
        resetForm()
        setInspectorOpen(false)
      }
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar')
    }
  }

  const handleDelete = async () => {
    if (!editingId) return
    if (!window.confirm('¿Eliminar este perfil y sus vínculos?')) return
    try {
      await api.deletePerson(editingId)
      resetForm()
      setInspectorOpen(false)
      await load()
      onChanged?.()
      setStatus('Perfil eliminado')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar')
    }
  }

  const handleAttach = async (waitingIds: string | string[], masterId: string) => {
    const ids = Array.isArray(waitingIds) ? waitingIds : [waitingIds]
    if (ids.length === 0) return
    const master = profiles.find((p) => p.id === masterId)
    setBusyId(ids[0] ?? null)
    let ok = 0
    const aliases: string[] = []
    try {
      for (const waitingId of ids) {
        const waitingEntity = waiting.find((p) => p.id === waitingId)
        try {
          const res = await api.attachWaitingToProfile(waitingId, masterId)
          ok += 1
          const added =
            res.alias_added?.trim() || waitingEntity?.name?.trim() || null
          if (added) aliases.push(added)
        } catch {
          /* cuenta fallos abajo */
        }
      }
      setSelectedWaitingIds([])
      await load()
      onChanged?.()

      if (selectedId === masterId || editingId === masterId) {
        try {
          const data = await api.getPerson(masterId)
          setLinks(data.links)
          setFormAliases((data.person.aliases_list ?? []).join(', '))
          setFormName(data.person.name)
          setFormKind(normalizeKind(data.person.kind))
          setFormNotes(data.person.notes ?? '')
        } catch {
          /* ignore */
        }
      }

      const masterName = master?.name
      if (ok === 0) {
        setError('No se pudo vincular ninguna entidad')
      } else if (ok === 1 && aliases[0] && masterName) {
        setStatus(
          aliases[0].toLowerCase() !== masterName.toLowerCase()
            ? `«${aliases[0]}» quedó como alias de ${masterName}`
            : `Vinculado a ${masterName}`,
        )
      } else {
        setStatus(
          masterName
            ? `${ok} entidades → alias de ${masterName}`
            : `Vinculadas ${ok} entidades`,
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al vincular')
    } finally {
      setBusyId(null)
      setDragWaitingIds([])
      setDropTargetId(null)
    }
  }

  const toggleWaitingSelect = (id: string, additive: boolean) => {
    setSelectedWaitingIds((prev) => {
      if (additive) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      }
      return prev.length === 1 && prev[0] === id ? [] : [id]
    })
  }

  const handleCreateNew = async (p: EntityProposalView) => {
    const name = (draftNames[p.id] ?? p.suggested_name).trim()
    const kind = draftKinds[p.id] ?? normalizeKind(p.meta.kind)
    if (!name) return
    await resolveProposal(
      p.id,
      async () => {
        const res = await api.approvePersonProposal(p.id, {
          name,
          kind,
          as: 'create',
        })
        setStatus(
          res.discarded
            ? `Descartado como ${KIND_LABEL[kind] ?? kind}`
            : 'Mención → sala de espera',
        )
      },
    )
  }

  const handleLinkProposal = async (
    p: EntityProposalView,
    targetId?: string,
  ) => {
    const matched =
      targetId ||
      linkPick[p.id] ||
      p.suggested_match?.id ||
      p.matched_entity_id
    if (!matched) {
      setError('Elegí un perfil destino')
      return
    }
    await resolveProposal(
      p.id,
      async () => {
        await api.approvePersonProposal(p.id, {
          name: (draftNames[p.id] ?? p.suggested_name).trim(),
          matched_entity_id: matched,
          as: 'link',
        })
      },
      'Mención vinculada a perfil',
    )
  }

  const handleReject = async (id: string, reason = 'manual') => {
    await resolveProposal(id, async () => {
      await api.rejectPersonProposal(id, reason)
    }, 'Mención descartada')
  }

  const handleExportAll = async () => {
    if (profiles.length === 0) return
    setError(null)
    try {
      const payload = await api.exportPersons()
      const day = new Date().toISOString().slice(0, 10)
      downloadJson(`deprocast-personas-${day}.json`, payload)
      setStatus(`Exportados ${payload.count} perfiles`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al exportar')
    }
  }

  const refreshInspector = async (id: string) => {
    const data = await api.getPerson(id)
    setLinks(data.links)
    setRelations(data.relations ?? [])
    setProjectLinks(data.project_links ?? [])
    setOperatorId(data.operator_id ?? null)
    setFormAliases((data.person.aliases_list ?? []).join(', '))
  }

  const handleSetOperator = async () => {
    if (!editingId) return
    const enable = !(
      profiles.find((p) => p.id === editingId)?.is_operator ||
      operatorId === editingId
    )
    try {
      const res = await api.setPersonOperator(editingId, enable)
      setOperatorId(res.operator_id)
      await load()
      await refreshInspector(editingId)
      setStatus(
        enable
          ? 'Marcado como Yo | Operador'
          : 'Ya no es el perfil operador',
      )
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al marcar operador')
    }
  }

  const handleAddRelation = async (toOperator = false) => {
    if (!editingId) return
    try {
      await api.createPersonRelation(editingId, toOperator
        ? { to_operator: true, relation_type: relType }
        : { to_person_id: relTargetId, relation_type: relType })
      setRelTargetId('')
      await refreshInspector(editingId)
      await load()
      setStatus(toOperator ? 'Vinculado a Yo | Operador' : 'Relación creada')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al vincular')
    }
  }

  const handleDeleteRelation = async (relationId: string) => {
    if (!editingId) return
    try {
      await api.deletePersonRelation(relationId)
      await refreshInspector(editingId)
      setStatus('Relación eliminada')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al quitar relación')
    }
  }

  const handleLinkProject = async () => {
    if (!editingId || !projTargetId) return
    try {
      await api.linkPersonToProject(editingId, {
        project_id: projTargetId,
        role: projRole,
      })
      setProjTargetId('')
      await refreshInspector(editingId)
      setStatus('Vinculado a proyecto')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al vincular proyecto')
    }
  }

  const handleUnlinkProject = async (linkId: string) => {
    if (!editingId) return
    try {
      await api.unlinkPersonFromProject(linkId)
      await refreshInspector(editingId)
      setStatus('Vínculo a proyecto eliminado')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al desvincular')
    }
  }

  const isEditingOperator =
    !!editingId &&
    (!!profiles.find((p) => p.id === editingId)?.is_operator ||
      operatorId === editingId)

  return (
    <div className={embedded ? 'entity-stage-body' : 'entity-stage personas-stage'}>
      {!embedded && (
      <div className="personas-mode-switch" role="tablist" aria-label="Modo de vista">
        <button
          type="button"
          role="tab"
          aria-selected={personasMode === 'perfiles'}
          className={
            personasMode === 'perfiles'
              ? 'filter-chip is-active'
              : 'filter-chip'
          }
          onClick={() => switchPersonasMode('perfiles')}
        >
          Perfiles
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={personasMode === 'agrupaciones'}
          className={
            personasMode === 'agrupaciones'
              ? 'filter-chip is-active'
              : 'filter-chip'
          }
          onClick={() => switchPersonasMode('agrupaciones')}
        >
          Agrupaciones
          {agrupaciones.length > 0 ? (
            <span className="nav-badge">{agrupaciones.length}</span>
          ) : null}
        </button>
      </div>
      )}

      {/* —— Validador NER (menciones pendientes de audio/bookmarks) —— */}
      <section className="panel entity-panel entity-pending">
        <div className="panel-head entity-head">
          <div>
            <h2>
              Validador NER
              {proposals.length > 0 ? (
                <span className="nav-badge">{proposals.length}</span>
              ) : null}
            </h2>
            <p className="muted mono">
              Menciones nuevas (audio / criba) · acá llegan las del badge
            </p>
          </div>
          <div className="entity-head-actions">
            {proposals.length > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                onClick={() => {
                  setValidatorOpen(true)
                  setDeckOpen(true)
                }}
              >
                Validación
              </button>
            )}
            <button
              type="button"
              className="btn btn-tiny btn-ghost"
              onClick={() => setValidatorOpen((o) => !o)}
            >
              {validatorOpen ? 'Plegar' : 'Abrir'}
            </button>
          </div>
        </div>

        {validatorOpen &&
          (proposals.length === 0 ? (
            <p className="muted mono">Sin menciones pendientes</p>
          ) : (
            <ul className="proposal-list">
              {proposals.map((p) => {
                const kind =
                  draftKinds[p.id] ?? normalizeKind(p.meta.kind)
                const match = p.suggested_match
                const isNoise = kind === 'ruido' || kind === 'abstracta'
                const busy = busyId === p.id
                return (
                  <li key={p.id} className="proposal-card">
                    <div className="proposal-card-head">
                      <span
                        className={
                          match
                            ? 'badge badge-link'
                            : isNoise
                              ? 'badge badge-noise'
                              : 'badge badge-new'
                        }
                      >
                        {isNoise
                          ? KIND_LABEL[kind]
                          : match
                            ? 'Posible vínculo'
                            : 'Mención'}
                      </span>
                    </div>
                    <label className="field">
                      <span className="mono">Mención</span>
                      <input
                        value={draftNames[p.id] ?? p.suggested_name}
                        onChange={(e) =>
                          setDraftNames((d) => ({
                            ...d,
                            [p.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="mono">Clasificar</span>
                      <select
                        value={kind}
                        onChange={(e) =>
                          setDraftKinds((d) => ({
                            ...d,
                            [p.id]: e.target.value as PersonKind,
                          }))
                        }
                      >
                        <option value="fisica">Física</option>
                        <option value="juridica">Jurídica</option>
                        <option value="ficticia">Ficticia</option>
                        <option value="abstracta">Abstracta</option>
                        <option value="ruido">Ruido</option>
                      </select>
                    </label>
                    {p.evidence_parsed.snippet && (
                      <p className="proposal-evidence">
                        “{p.evidence_parsed.snippet}”
                      </p>
                    )}
                    {match && profiles.some((x) => x.id === match.id) && (
                      <button
                        type="button"
                        className="btn btn-primary btn-tiny"
                        disabled={busy}
                        onClick={() => void handleLinkProposal(p, match.id)}
                      >
                        Vincular a {match.name}
                      </button>
                    )}
                    <div className="actions-row proposal-actions">
                      <button
                        type="button"
                        className="btn btn-tiny btn-ghost danger"
                        disabled={busy}
                        onClick={() =>
                          void handleReject(p.id, isNoise ? kind : 'manual')
                        }
                      >
                        Descartar
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-tiny"
                        disabled={busy}
                        onClick={() => void handleCreateNew(p)}
                      >
                        {isNoise
                          ? `Descartar (${KIND_LABEL[kind]})`
                          : 'A sala de espera'}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ))}
      </section>

      <div className="personas-layout">
        {personasMode === 'perfiles' ? (
        /* —— Directorio: perfiles maestros —— */
        <section className="panel entity-panel profiles-directory">
          <div className="panel-head entity-head">
            <div>
              <h2>Perfiles</h2>
              <p className="muted mono">
                Directorio maestro · creados a mano
                {profiles.length > 0 ? ` · ${profiles.length}` : ''}
              </p>
            </div>
            <div className="entity-head-actions">
              <button
                type="button"
                className="btn btn-tiny btn-ghost"
                disabled={profiles.length === 0}
                onClick={() => void handleExportAll()}
              >
                Exportar todo
              </button>
              <button
                type="button"
                className="btn btn-tiny btn-primary"
                onClick={resetForm}
              >
                Nuevo perfil
              </button>
            </div>
          </div>

          {loading && profiles.length === 0 ? (
            <p className="muted mono">Cargando…</p>
          ) : profiles.length === 0 ? (
            <p className="muted mono profiles-empty">
              Sin perfiles maestros. Creá uno o promové desde la sala de
              espera.
            </p>
          ) : (
            <>
              <div className="profiles-toolbar">
                <div className="filter-rail" role="tablist" aria-label="Filtrar por tipo">
                  {(
                    [
                      ['all', 'Todos'],
                      ['fisica', 'Física'],
                      ['juridica', 'Jurídica'],
                      ['ficticia', 'Ficticia'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={kindFilter === value}
                      className={
                        kindFilter === value
                          ? 'filter-chip is-active'
                          : 'filter-chip'
                      }
                      onClick={() => setKindFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="semantic-search">
                  <span className="mono">Buscar</span>
                  <input
                    type="search"
                    value={semanticQuery}
                    onChange={(e) => setSemanticQuery(e.target.value)}
                    placeholder="Buscar por nombre o alias…"
                    aria-label="Búsqueda de perfiles"
                  />
                  {semanticBusy && (
                    <span className="semantic-search-hint mono">…</span>
                  )}
                  {semanticQuery.trim() && !semanticBusy && (
                    <button
                      type="button"
                      className="btn btn-tiny btn-ghost semantic-clear"
                      onClick={() => setSemanticQuery('')}
                    >
                      Limpiar
                    </button>
                  )}
                </label>
              </div>
              <div className="profile-card-grid">
                {filteredProfiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={[
                      'profile-card',
                      selectedId === p.id ? 'is-active' : '',
                      dropTargetId === p.id ? 'is-drop-target' : '',
                      dragWaitingIds.length > 0 ? 'is-droppable' : '',
                      p.is_operator || operatorId === p.id ? 'is-operator' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => void selectProfile(p.id)}
                    onDragOver={(e) => {
                      if (dragWaitingIds.length === 0) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'link'
                      setDropTargetId(p.id)
                    }}
                    onDragLeave={() => {
                      setDropTargetId((cur) => (cur === p.id ? null : cur))
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      let ids: string[] = []
                      try {
                        const raw = e.dataTransfer.getData('text/waiting-ids')
                        if (raw) ids = JSON.parse(raw) as string[]
                      } catch {
                        ids = []
                      }
                      if (ids.length === 0) {
                        const one =
                          e.dataTransfer.getData('text/waiting-id') ||
                          dragWaitingIds[0]
                        if (one) ids = [one]
                      }
                      setDropTargetId(null)
                      setDragWaitingIds([])
                      if (ids.length > 0) void handleAttach(ids, p.id)
                    }}
                  >
                    <span className="profile-avatar" aria-hidden>
                      {initials(p.name)}
                    </span>
                    <span className="profile-card-body">
                      <span className="profile-card-name">
                        {p.name}
                        {(p.is_operator || operatorId === p.id) && (
                          <span className="operator-badge mono">Yo</span>
                        )}
                      </span>
                      <span className="profile-card-meta mono">
                        {KIND_LABEL[normalizeKind(p.kind)] ?? p.kind}
                        {semanticScores[p.id] != null
                          ? ` · ${Math.round(semanticScores[p.id]! * 100)}%`
                          : ''}
                        {typeof p.link_count === 'number'
                          ? ` · ${p.link_count} vínculos`
                          : ''}
                        {(p.aliases_list?.length ?? 0) > 0
                          ? ` · ${p.aliases_list!.length} alias`
                          : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              {filteredProfiles.length === 0 && (
                <p className="muted mono">
                  {semanticQuery.trim()
                    ? 'Sin coincidencias'
                    : 'Nada en este filtro'}
                </p>
              )}
            </>
          )}

          {inspectorOpen && (
            <div className="profile-inspector">
              <h3 className="mono">
                {promoteId
                  ? 'Promover a perfil'
                  : editingId
                    ? 'Inspector'
                    : 'Crear perfil'}
              </h3>
              <label className="field">
                <span className="mono">Nombre</span>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="Nombre o razón social"
                />
              </label>
              <label className="field">
                <span className="mono">Tipo</span>
                <select
                  value={formKind}
                  onChange={(e) => setFormKind(e.target.value as PersonKind)}
                >
                  {PROFILE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="mono">Aliases</span>
                <input
                  value={formAliases}
                  onChange={(e) => setFormAliases(e.target.value)}
                  placeholder="Cami, Amorcito, Kamila"
                />
              </label>
              <label className="field">
                <span className="mono">Notas</span>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={3}
                  placeholder="Contexto operativo"
                />
              </label>
              <div className="actions-row">
                {editingId && !promoteId && (
                  <button
                    type="button"
                    className="btn btn-tiny btn-ghost danger"
                    onClick={() => void handleDelete()}
                  >
                    Eliminar
                  </button>
                )}
                {editingId && !promoteId && (
                  <button
                    type="button"
                    className={
                      isEditingOperator
                        ? 'btn btn-tiny btn-primary'
                        : 'btn btn-tiny btn-ghost'
                    }
                    onClick={() => void handleSetOperator()}
                  >
                    {isEditingOperator ? 'Yo | Operador' : 'Marcar Yo | Operador'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-tiny btn-ghost"
                  onClick={() => {
                    setInspectorOpen(false)
                    setPromoteId(null)
                  }}
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  disabled={!formName.trim()}
                  onClick={() => void handleSave()}
                >
                  {promoteId
                    ? 'Confirmar promoción'
                    : editingId
                      ? 'Guardar'
                      : 'Crear perfil'}
                </button>
              </div>

              {editingId && !promoteId && (
                <div className="relation-block">
                  <h4 className="mono">Relaciones entre personas</h4>
                  <div className="relation-add">
                    <select
                      value={relType}
                      onChange={(e) =>
                        setRelType(e.target.value as PersonRelationType)
                      }
                    >
                      {(Object.keys(RELATION_LABEL) as PersonRelationType[]).map(
                        (k) => (
                          <option key={k} value={k}>
                            {RELATION_LABEL[k]}
                          </option>
                        ),
                      )}
                    </select>
                    <select
                      value={relTargetId}
                      onChange={(e) => setRelTargetId(e.target.value)}
                    >
                      <option value="">— vincular a persona —</option>
                      {profiles
                        .filter((p) => p.id !== editingId)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.is_operator || operatorId === p.id
                              ? ' · Yo'
                              : ''}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-tiny"
                      disabled={!relTargetId}
                      onClick={() => void handleAddRelation(false)}
                    >
                      Vincular
                    </button>
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={!operatorId || operatorId === editingId}
                      onClick={() => void handleAddRelation(true)}
                      title={
                        operatorId
                          ? 'Vincular a tu perfil operador'
                          : 'Marcá un perfil como Yo | Operador primero'
                      }
                    >
                      Vincular a mí
                    </button>
                  </div>
                  {relations.length === 0 ? (
                    <p className="muted mono">Sin relaciones</p>
                  ) : (
                    <ul className="item-edit-list">
                      {relations.map((r) => (
                        <li key={r.id} className="mono relation-row">
                          <span>
                            {RELATION_LABEL[
                              r.relation_type as PersonRelationType
                            ] ?? r.relation_type}{' '}
                            · {r.other_name ?? r.to_name ?? r.from_name}
                            {r.direction === 'in' ? ' ←' : ' →'}
                          </span>
                          <button
                            type="button"
                            className="btn btn-tiny btn-ghost danger"
                            onClick={() => void handleDeleteRelation(r.id)}
                          >
                            Quitar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {editingId && !promoteId && (
                <div className="relation-block">
                  <h4 className="mono">Proyectos · tareas · conceptos</h4>
                  <div className="relation-add">
                    <select
                      value={projRole}
                      onChange={(e) =>
                        setProjRole(e.target.value as PersonProjectRole)
                      }
                    >
                      {(Object.keys(ROLE_LABEL) as PersonProjectRole[]).map(
                        (k) => (
                          <option key={k} value={k}>
                            {ROLE_LABEL[k]}
                          </option>
                        ),
                      )}
                    </select>
                    <select
                      value={projTargetId}
                      onChange={(e) => setProjTargetId(e.target.value)}
                    >
                      <option value="">— vincular a… —</option>
                      {allProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {PROJECT_KIND_LABEL[
                            (p.category as ProjectKind) || 'proyecto'
                          ] ?? 'Proyecto'}{' '}
                          · {p.title}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={!projTargetId}
                      onClick={() => void handleLinkProject()}
                    >
                      Vincular
                    </button>
                  </div>
                  {projectLinks.length === 0 ? (
                    <p className="muted mono">Sin proyectos vinculados</p>
                  ) : (
                    <ul className="item-edit-list">
                      {projectLinks.map((pl) => (
                        <li key={pl.id} className="mono relation-row">
                          <span>
                            {ROLE_LABEL[pl.role as PersonProjectRole] ??
                              pl.role}{' '}
                            ·{' '}
                            {PROJECT_KIND_LABEL[
                              (pl.project_category as ProjectKind) || 'proyecto'
                            ] ?? pl.project_category}{' '}
                            · {pl.project_title}
                          </span>
                          <button
                            type="button"
                            className="btn btn-tiny btn-ghost danger"
                            onClick={() => void handleUnlinkProject(pl.id)}
                          >
                            Quitar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {editingId && !promoteId && links.length > 0 && (
                <div className="entity-links">
                  <h4 className="mono">Validaciones vinculadas</h4>
                  <ul className="item-edit-list">
                    {links.map((l) => (
                      <li key={l.id} className="mono">
                        <span>{l.entry_title ?? l.entry_id}</span>
                        <span className="muted">{l.role}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {editingId && !promoteId && (
                <div className="relation-block">
                  <h4 className="mono">Agrupaciones</h4>
                  <div className="relation-add">
                    <select
                      value={addToAgrupacionId}
                      onChange={(e) => setAddToAgrupacionId(e.target.value)}
                    >
                      <option value="">— añadir a… —</option>
                      {agrupaciones
                        .filter(
                          (a) =>
                            !personAgrupaciones.some((pa) => pa.id === a.id),
                        )
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={!addToAgrupacionId}
                      onClick={() => void handleAddPersonToAgrupacion()}
                    >
                      Añadir
                    </button>
                  </div>
                  {personAgrupaciones.length === 0 ? (
                    <p className="muted mono">Sin agrupaciones</p>
                  ) : (
                    <ul className="item-edit-list">
                      {personAgrupaciones.map((a) => (
                        <li key={a.id} className="mono relation-row">
                          <span>{a.name}</span>
                          <button
                            type="button"
                            className="btn btn-tiny btn-ghost danger"
                            onClick={() =>
                              void handleRemovePersonFromAgrupacion(a.id)
                            }
                          >
                            Quitar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
        ) : (
        /* —— Agrupaciones —— */
        <section className="panel entity-panel profiles-directory agrupaciones-directory">
          <div className="panel-head entity-head">
            <div>
              <h2>Agrupaciones</h2>
              <p className="muted mono">
                Contenedores many-to-many · perfiles y entidades validadas
                {agrupaciones.length > 0 ? ` · ${agrupaciones.length}` : ''}
              </p>
            </div>
            <div className="entity-head-actions">
              <button
                type="button"
                className="btn btn-tiny btn-primary"
                onClick={resetAgrupacionForm}
              >
                Nueva agrupación
              </button>
            </div>
          </div>

          {loading && agrupaciones.length === 0 ? (
            <p className="muted mono">Cargando…</p>
          ) : agrupaciones.length === 0 ? (
            <p className="muted mono profiles-empty">
              Sin agrupaciones. Creá una (p. ej. Pensadores, Argentinos,
              Amigos, Tecnología).
            </p>
          ) : (
            <div className="profile-card-grid">
              {agrupaciones.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={[
                    'profile-card',
                    selectedAgrupacionId === a.id ? 'is-active' : '',
                    dropTargetId === a.id ? 'is-drop-target' : '',
                    dragWaitingIds.length > 0 ? 'is-droppable' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => void selectAgrupacion(a.id)}
                  onDragOver={(e) => {
                    if (dragWaitingIds.length === 0) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'link'
                    setDropTargetId(a.id)
                  }}
                  onDragLeave={() => {
                    setDropTargetId((cur) => (cur === a.id ? null : cur))
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    let ids: string[] = []
                    try {
                      const raw = e.dataTransfer.getData('text/waiting-ids')
                      if (raw) ids = JSON.parse(raw) as string[]
                    } catch {
                      /* ignore */
                    }
                    setDropTargetId(null)
                    setDragWaitingIds([])
                    if (ids.length === 0) return
                    void (async () => {
                      for (const pid of ids) {
                        try {
                          await api.addAgrupacionMember(a.id, pid)
                        } catch {
                          /* skip duplicates */
                        }
                      }
                      setStatus(
                        `Añadidos ${ids.length} a «${a.name}»`,
                      )
                      await selectAgrupacion(a.id)
                      onChanged?.()
                      await load()
                    })()
                  }}
                >
                  <span className="profile-card-avatar" aria-hidden>
                    {initials(a.name)}
                  </span>
                  <span className="profile-card-body">
                    <span className="profile-card-name">{a.name}</span>
                    <span className="profile-card-meta mono">
                      {a.member_count ?? 0} miembro
                      {(a.member_count ?? 0) === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {agrupacionInspectorOpen && (
            <div className="profile-inspector">
              <h3 className="mono">
                {agrupacionEditingId ? 'Inspector' : 'Crear agrupación'}
              </h3>
              <label className="field">
                <span className="mono">Nombre</span>
                <input
                  value={agrupFormName}
                  onChange={(e) => setAgrupFormName(e.target.value)}
                  placeholder="Pensadores y escritores"
                />
              </label>
              <label className="field">
                <span className="mono">Notas (texto libre)</span>
                <textarea
                  value={agrupFormNotes}
                  onChange={(e) => setAgrupFormNotes(e.target.value)}
                  rows={6}
                  placeholder={
                    'Criterio, bullets, origen compartido, vínculos…\nEl sistema generará metadata a partir de esto.'
                  }
                />
              </label>

              {agrupacionEditingId && (
                <div className="relation-block">
                  <h4 className="mono">Miembros</h4>
                  <div className="relation-add">
                    <select
                      value={agrupMemberPick}
                      onChange={(e) => setAgrupMemberPick(e.target.value)}
                    >
                      <option value="">— vincular persona —</option>
                      {candidateMembers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p._bucket === 'waiting'
                            ? ' · ent. validada'
                            : ' · perfil'}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={!agrupMemberPick}
                      onClick={() => void handleAddAgrupacionMember()}
                    >
                      Vincular
                    </button>
                  </div>
                  {agrupacionMembers.length === 0 ? (
                    <p className="muted mono">
                      Sin miembros · arrastrá desde sala de espera o elegí
                      arriba
                    </p>
                  ) : (
                    <ul className="item-edit-list agrupacion-member-list">
                      {agrupacionMembers.map((m) => (
                        <li key={m.id} className="mono relation-row">
                          <span>
                            {m.person_name ?? m.person_id}
                            <span className="muted">
                              {' '}
                              ·{' '}
                              {m.person_source === 'manual'
                                ? 'perfil'
                                : 'ent. validada'}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="btn btn-tiny btn-ghost danger"
                            onClick={() =>
                              void handleRemoveAgrupacionMember(m.person_id)
                            }
                          >
                            Quitar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {agrupacionEditingId && (
                <div className="relation-block agrupacion-meta-block">
                  <div className="agrupacion-meta-head">
                    <h4 className="mono">Metadata generada</h4>
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={agrupProcessBusy || !agrupFormName.trim()}
                      onClick={() => void handleProcessAgrupacion()}
                    >
                      {agrupProcessBusy ? 'Generando…' : 'Generar metadata'}
                    </button>
                  </div>
                  {!hasMetaContent(agrupGeneratedMeta) ? (
                    <p className="muted mono">
                      Todavía no hay metadata. Escribí notas y generá.
                    </p>
                  ) : (
                    <div className="agrupacion-meta-view">
                      {agrupGeneratedMeta?.summary ? (
                        <p className="agrupacion-meta-summary">
                          {agrupGeneratedMeta.summary}
                        </p>
                      ) : null}
                      {agrupGeneratedMeta &&
                        agrupGeneratedMeta.tags.length > 0 && (
                          <div className="agrupacion-meta-chips">
                            {agrupGeneratedMeta.tags.map((t) => (
                              <span key={`tag-${t}`} className="filter-chip">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      {agrupGeneratedMeta &&
                        agrupGeneratedMeta.themes.length > 0 && (
                          <p className="mono muted">
                            Temas · {agrupGeneratedMeta.themes.join(' · ')}
                          </p>
                        )}
                      {agrupGeneratedMeta &&
                        agrupGeneratedMeta.related_categories.length > 0 && (
                          <p className="mono muted">
                            Categorías ·{' '}
                            {agrupGeneratedMeta.related_categories.join(' · ')}
                          </p>
                        )}
                      {agrupGeneratedMeta &&
                        agrupGeneratedMeta.related_person_names.length >
                          0 && (
                          <p className="mono muted">
                            Personas ·{' '}
                            {agrupGeneratedMeta.related_person_names.join(
                              ' · ',
                            )}
                          </p>
                        )}
                      {agrupGeneratedMeta &&
                        agrupGeneratedMeta.inferred_facts.length > 0 && (
                          <ul className="agrupacion-facts">
                            {agrupGeneratedMeta.inferred_facts.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                        )}
                    </div>
                  )}
                </div>
              )}

              <div className="actions-row">
                {agrupacionEditingId && (
                  <button
                    type="button"
                    className="btn btn-tiny btn-ghost danger"
                    onClick={() => void handleDeleteAgrupacion()}
                  >
                    Eliminar
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-tiny btn-ghost"
                  onClick={() => {
                    setAgrupacionInspectorOpen(false)
                  }}
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-tiny"
                  disabled={!agrupFormName.trim()}
                  onClick={() => void handleSaveAgrupacion()}
                >
                  {agrupacionEditingId ? 'Guardar' : 'Crear agrupación'}
                </button>
              </div>
            </div>
          )}
        </section>
        )}

        {/* —— Sala de espera + bandeja grafo —— */}
        <div className="personas-side-rail">
        <aside
          className={
            waitingOpen
              ? 'panel entity-panel waiting-room'
              : 'panel entity-panel waiting-room is-collapsed'
          }
        >
          <div className="panel-head entity-head">
            <div>
              <h2>Sala de espera</h2>
              <p className="muted mono">
                Entidades validadas sin perfil
                {waiting.length > 0 ? ` · ${waiting.length}` : ''}
                {matchedWaiting.length > 0
                  ? ` · ${matchedWaiting.length} sugeridas`
                  : ''}
                {selectedWaitingIds.length > 0
                  ? ` · ${selectedWaitingIds.length} sel.`
                  : ''}
              </p>
            </div>
            <div className="entity-head-actions">
              {selectedWaitingIds.length > 0 && (
                <button
                  type="button"
                  className="btn btn-tiny btn-ghost"
                  onClick={() => setSelectedWaitingIds([])}
                >
                  Limpiar sel.
                </button>
              )}
              <button
                type="button"
                className="btn btn-tiny btn-ghost"
                onClick={() => setWaitingOpen((o) => !o)}
              >
                {waitingOpen ? 'Plegar' : 'Abrir'}
              </button>
            </div>
          </div>

          {waitingOpen && (
            <>
              {waiting.length === 0 ? (
                <p className="muted mono">
                  Vacía · las menciones aprobadas llegan acá
                </p>
              ) : (
                <>
                  <p className="muted mono waiting-hint-line">
                    {personasMode === 'agrupaciones'
                      ? 'Ctrl+clic para multiselección · arrastrá a una agrupación'
                      : 'Ctrl+clic para multiselección · arrastrá al perfil'}
                  </p>
                  <ul className="waiting-pill-list">
                    {waiting.map((w) => {
                      const match = w.suggested_match
                      const busy =
                        busyId === w.id ||
                        (busyId !== null && selectedWaitingIds.includes(w.id))
                      const selected = selectedWaitingIds.includes(w.id)
                      const dragging = dragWaitingIds.includes(w.id)
                      return (
                        <li
                          key={w.id}
                          className={[
                            'waiting-pill',
                            selected ? 'is-selected' : '',
                            dragging ? 'is-dragging' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          draggable={!busy}
                          onClick={(e) => {
                            // no interferir con controles internos
                            const t = e.target as HTMLElement
                            if (
                              t.closest('button, select, input, .waiting-hint')
                            ) {
                              return
                            }
                            e.preventDefault()
                            toggleWaitingSelect(
                              w.id,
                              e.ctrlKey || e.metaKey,
                            )
                          }}
                          onDragStart={(e) => {
                            const bundle =
                              selectedWaitingIds.includes(w.id) &&
                              selectedWaitingIds.length > 0
                                ? selectedWaitingIds
                                : [w.id]
                            e.dataTransfer.setData(
                              'text/waiting-ids',
                              JSON.stringify(bundle),
                            )
                            e.dataTransfer.setData(
                              'text/waiting-id',
                              bundle[0]!,
                            )
                            e.dataTransfer.effectAllowed = 'link'
                            setDragWaitingIds(bundle)
                            if (!selectedWaitingIds.includes(w.id)) {
                              setSelectedWaitingIds([w.id])
                            }
                          }}
                          onDragEnd={() => {
                            setDragWaitingIds([])
                            setDropTargetId(null)
                          }}
                        >
                          <div className="waiting-pill-top">
                            <span className="waiting-pill-name">
                              {selected && (
                                <span className="waiting-sel-mark" aria-hidden>
                                  ✓
                                </span>
                              )}
                              {w.name}
                            </span>
                            <span className="waiting-hint">
                              <span className="waiting-hint-mark" aria-hidden>
                                ?
                              </span>
                              <span className="waiting-hint-pop" role="tooltip">
                                {w.source_file && (
                                  <span className="waiting-hint-file mono">
                                    {w.source_file}
                                  </span>
                                )}
                                <span className="waiting-hint-snip">
                                  {w.evidence_snippet
                                    ? `“${w.evidence_snippet}”`
                                    : 'Sin fragmento de mención disponible'}
                                </span>
                              </span>
                            </span>
                          </div>

                          <div className="waiting-pill-actions">
                            {profiles.length > 0 ? (
                              <select
                                className="waiting-link-select"
                                defaultValue={match?.id ?? ''}
                                disabled={busy}
                                aria-label="Vincular a perfil"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  const id = e.target.value
                                  if (id) {
                                    const bundle =
                                      selectedWaitingIds.includes(w.id) &&
                                      selectedWaitingIds.length > 1
                                        ? selectedWaitingIds
                                        : [w.id]
                                    void handleAttach(bundle, id)
                                  }
                                  e.target.value = match?.id ?? ''
                                }}
                              >
                                <option value="">— vincular a… —</option>
                                {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                    {match?.id === p.id
                                      ? ` · ${Math.round(match.score * 100)}%`
                                      : ''}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="waiting-link-placeholder muted mono">
                                Sin perfiles
                              </span>
                            )}
                            <button
                              type="button"
                              className="btn btn-tiny btn-promote"
                              disabled={busy}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                openPromote(w)
                              }}
                            >
                              Promover a perfil nuevo
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </aside>

        <SuggestedLinksTray
          personId={selectedId}
          refreshKey={refreshKey}
          onLinked={() => {
            void load()
            if (selectedId) void refreshInspector(selectedId)
            onChanged?.()
          }}
        />
        </div>
      </div>

      {status && <p className="status-line ok">{status}</p>}
      {error && <p className="status-line err">{error}</p>}

      <NerValidationDeck
        open={deckOpen}
        onClose={() => setDeckOpen(false)}
        variant="person"
        proposals={proposals}
        names={draftNames}
        classes={draftKinds}
        classOptions={[
          { value: 'fisica', label: 'Física' },
          { value: 'juridica', label: 'Jurídica' },
          { value: 'ficticia', label: 'Ficticia' },
          { value: 'abstracta', label: 'Abstracta' },
          { value: 'ruido', label: 'Ruido' },
        ]}
        onNameChange={(id, value) =>
          setDraftNames((d) => ({ ...d, [id]: value }))
        }
        onClassChange={(id, value) =>
          setDraftKinds((d) => ({ ...d, [id]: value as PersonKind }))
        }
        onDiscard={async (p) => {
          const kind = draftKinds[p.id] ?? normalizeKind(p.meta.kind)
          const isNoise = kind === 'ruido' || kind === 'abstracta'
          await handleReject(p.id, isNoise ? kind : 'manual')
        }}
        onWaiting={async (p) => {
          await handleCreateNew(p)
        }}
        onLink={async (p, targetId) => {
          await handleLinkProposal(p, targetId)
        }}
      />
    </div>
  )
}
