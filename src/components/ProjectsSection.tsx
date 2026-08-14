import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../services/api'
import type {
  EntityLink,
  EntityProposalView,
  Person,
  PersonProjectLink,
  PersonProjectRole,
  Project,
  ProjectKind,
  ProjectStatus,
} from '../types'
import { downloadJson } from '../utils/downloadJson'
import { SuggestedLinksTray } from './SuggestedLinksTray'
import { NerValidationDeck } from './NerValidationDeck'

interface Props {
  refreshKey: number
  onChanged?: () => void
  /** Sin wrapper entity-stage (lo pone EntityHub) */
  embedded?: boolean
}

const KIND_LABEL: Record<ProjectKind, string> = {
  proyecto: 'Proyecto',
  tarea: 'Tarea / reto',
  concepto: 'Concepto',
}

const ROLE_LABEL: Record<PersonProjectRole, string> = {
  responsable: 'Responsable',
  miembro: 'Miembro',
  participante: 'Participante',
  interesado: 'Interesado',
  co_mentioned: 'Co-mencionado',
}

function normalizeProjectKind(k: unknown): ProjectKind {
  const s = String(k ?? 'proyecto').toLowerCase()
  if (s === 'tarea' || s === 'concepto') return s
  return 'proyecto'
}

function initials(title: string): string {
  const parts = title.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}

export function ProjectsSection({
  refreshKey,
  onChanged,
  embedded = false,
}: Props) {
  const [profiles, setProfiles] = useState<Project[]>([])
  const [waiting, setWaiting] = useState<Project[]>([])
  const [proposals, setProposals] = useState<EntityProposalView[]>([])
  const [persons, setPersons] = useState<Person[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [links, setLinks] = useState<EntityLink[]>([])
  const [people, setPeople] = useState<PersonProjectLink[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [waitingOpen, setWaitingOpen] = useState(true)
  const [validatorOpen, setValidatorOpen] = useState(false)
  const [deckOpen, setDeckOpen] = useState(false)
  const [kindFilter, setKindFilter] = useState<ProjectKind | 'all'>('all')

  const [formTitle, setFormTitle] = useState('')
  const [formCategory, setFormCategory] = useState<ProjectKind>('proyecto')
  const [formStatus, setFormStatus] = useState<ProjectStatus>('activo')
  const [formFocus, setFormFocus] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [formAliases, setFormAliases] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)

  const [draftTitles, setDraftTitles] = useState<Record<string, string>>({})
  const [draftCategories, setDraftCategories] = useState<
    Record<string, ProjectKind>
  >({})
  const [draftStatuses, setDraftStatuses] = useState<
    Record<string, ProjectStatus>
  >({})
  const [draftFocuses, setDraftFocuses] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyAll, setBusyAll] = useState(false)

  const [dragWaitingIds, setDragWaitingIds] = useState<string[]>([])
  const [selectedWaitingIds, setSelectedWaitingIds] = useState<string[]>([])
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const [semanticQuery, setSemanticQuery] = useState('')
  const [semanticIds, setSemanticIds] = useState<string[] | null>(null)
  const [semanticScores, setSemanticScores] = useState<Record<string, number>>(
    {},
  )
  const [semanticBusy, setSemanticBusy] = useState(false)

  const [personPick, setPersonPick] = useState('')
  const [personRole, setPersonRole] = useState<PersonProjectRole>('miembro')

  const selectedIdRef = useRef(selectedId)
  const hasLoadedRef = useRef(false)
  const proposalInFlightRef = useRef(new Set<string>())
  const loadGenRef = useRef(0)

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = opts?.quiet ?? false
    const gen = ++loadGenRef.current
    if (!quiet) setLoading(true)
    if (!quiet) setError(null)
    try {
      const [map, pending, personsMap] = await Promise.all([
        api.listProjects(),
        api.getPendingProjects(),
        api.listPersons(),
      ])
      if (gen !== loadGenRef.current) return

      const nextProfiles = map.profiles ?? map.projects ?? []
      setProfiles(nextProfiles)
      setWaiting(map.waiting ?? [])
      setPersons(personsMap.profiles ?? personsMap.persons ?? [])
      const inFlight = proposalInFlightRef.current
      setProposals(
        pending.proposals.filter((p) => !inFlight.has(p.id)),
      )
      setDraftTitles((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) next[p.id] = p.suggested_name
        }
        return next
      })
      setDraftCategories((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) {
            next[p.id] = normalizeProjectKind(p.meta.category ?? 'proyecto')
          }
        }
        return next
      })
      setDraftStatuses((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) {
            const st = String(p.meta.status ?? 'emergente') as ProjectStatus
            next[p.id] = [
              'activo',
              'pausado',
              'cerrado',
              'emergente',
            ].includes(st)
              ? st
              : 'emergente'
          }
        }
        return next
      })
      setDraftFocuses((prev) => {
        const next = { ...prev }
        for (const p of pending.proposals) {
          if (next[p.id] === undefined) {
            next[p.id] =
              typeof p.meta.tactical_focus === 'string'
                ? p.meta.tactical_focus
                : ''
          }
        }
        return next
      })
      const sid = selectedIdRef.current
      if (sid && !nextProfiles.some((p) => p.id === sid)) {
        setSelectedId(null)
        setLinks([])
        setPeople([])
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
        if (successMsg) setStatusMsg(successMsg)
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
      list = list.filter(
        (p) => normalizeProjectKind(p.category) === kindFilter,
      )
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
          const res = await api.searchProjects(q, {
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

  useEffect(() => {
    const alive = new Set(waiting.map((w) => w.id))
    setSelectedWaitingIds((prev) => prev.filter((id) => alive.has(id)))
  }, [waiting])

  const selectProfile = async (id: string) => {
    setSelectedId(id)
    setPromoteId(null)
    setInspectorOpen(true)
    setStatusMsg(null)
    setPersonPick('')
    try {
      const data = await api.getProject(id)
      setLinks(data.links)
      setPeople(data.people ?? [])
      setEditingId(id)
      setFormTitle(data.project.title)
      setFormCategory(normalizeProjectKind(data.project.category))
      setFormStatus((data.project.status as ProjectStatus) || 'activo')
      setFormFocus(data.project.tactical_focus ?? '')
      setFormNotes(data.project.notes ?? '')
      setFormAliases((data.project.aliases_list ?? []).join(', '))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al abrir ficha')
    }
  }

  const resetForm = () => {
    setEditingId(null)
    setPromoteId(null)
    setFormTitle('')
    setFormCategory('proyecto')
    setFormStatus('activo')
    setFormFocus('')
    setFormNotes('')
    setFormAliases('')
    setSelectedId(null)
    setLinks([])
    setPeople([])
    setInspectorOpen(true)
  }

  const openPromote = (w: Project) => {
    setPromoteId(w.id)
    setEditingId(null)
    setSelectedId(null)
    setLinks([])
    setPeople([])
    setFormTitle(w.title)
    setFormCategory(normalizeProjectKind(w.category))
    setFormStatus((w.status as ProjectStatus) || 'activo')
    setFormFocus(w.tactical_focus ?? '')
    setFormNotes(w.notes ?? '')
    setFormAliases((w.aliases_list ?? []).join(', '))
    setInspectorOpen(true)
    setStatusMsg(`Promover «${w.title}» a maestro`)
  }

  const handleSave = async () => {
    if (!formTitle.trim()) return
    setStatusMsg(null)
    try {
      if (promoteId) {
        await api.promoteToProject(promoteId, {
          title: formTitle.trim(),
          category: formCategory,
          status: formStatus,
          tactical_focus: formFocus,
          notes: formNotes,
          aliases: formAliases,
        })
        setStatusMsg('Promovido al directorio')
        setPromoteId(null)
        setEditingId(null)
        setInspectorOpen(false)
      } else if (editingId) {
        await api.updateProject(editingId, {
          title: formTitle.trim(),
          category: formCategory,
          status: formStatus,
          tactical_focus: formFocus,
          notes: formNotes,
          aliases: formAliases,
        })
        setStatusMsg('Proyecto actualizado')
      } else {
        await api.createProject({
          title: formTitle.trim(),
          category: formCategory,
          status: formStatus,
          tactical_focus: formFocus,
          notes: formNotes,
          aliases: formAliases,
        })
        setStatusMsg('Proyecto registrado')
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
    if (!window.confirm('¿Eliminar este proyecto y sus vínculos?')) return
    try {
      await api.deleteProject(editingId)
      resetForm()
      setInspectorOpen(false)
      await load()
      onChanged?.()
      setStatusMsg('Proyecto eliminado')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar')
    }
  }

  const handleAttach = async (
    waitingIds: string | string[],
    masterId: string,
  ) => {
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
          const res = await api.attachWaitingToProject(waitingId, masterId)
          ok += 1
          const added =
            res.alias_added?.trim() || waitingEntity?.title?.trim() || null
          if (added) aliases.push(added)
        } catch {
          /* continue */
        }
      }
      setSelectedWaitingIds([])
      await load()
      onChanged?.()
      if (selectedId === masterId || editingId === masterId) {
        try {
          const data = await api.getProject(masterId)
          setLinks(data.links)
          setPeople(data.people ?? [])
          setFormAliases((data.project.aliases_list ?? []).join(', '))
        } catch {
          /* ignore */
        }
      }
      const masterName = master?.title
      if (ok === 0) setError('No se pudo vincular ninguna entidad')
      else if (ok === 1 && aliases[0] && masterName) {
        setStatusMsg(
          aliases[0].toLowerCase() !== masterName.toLowerCase()
            ? `«${aliases[0]}» quedó como alias de ${masterName}`
            : `Vinculado a ${masterName}`,
        )
      } else {
        setStatusMsg(
          masterName
            ? `${ok} entidades → alias de ${masterName}`
            : `Vinculadas ${ok}`,
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
    const title = (draftTitles[p.id] ?? p.suggested_name).trim()
    if (!title) return
    await resolveProposal(
      p.id,
      async () => {
        await api.approveProjectProposal(p.id, {
          title,
          category: draftCategories[p.id] ?? 'proyecto',
          status: draftStatuses[p.id] ?? 'emergente',
          tactical_focus: draftFocuses[p.id] || undefined,
          as: 'create',
        })
      },
      'Mención → sala de espera',
    )
  }

  const handleLinkProposal = async (
    p: EntityProposalView,
    targetId?: string,
  ) => {
    const matched =
      targetId || p.suggested_match?.id || p.matched_entity_id
    if (!matched) {
      setError('Elegí un proyecto destino')
      return
    }
    await resolveProposal(
      p.id,
      async () => {
        await api.approveProjectProposal(p.id, {
          title: (draftTitles[p.id] ?? p.suggested_name).trim(),
          matched_entity_id: matched,
          as: 'link',
        })
      },
      'Mención vinculada a maestro',
    )
  }

  const handleReject = async (id: string) => {
    await resolveProposal(
      id,
      async () => {
        await api.rejectProjectProposal(id)
      },
      'Mención descartada',
    )
  }

  const handleApproveAll = async () => {
    if (proposals.length === 0) return
    if (
      !window.confirm(
        `¿Enviar las ${proposals.length} propuestas a sala de espera / vincular sugeridos?`,
      )
    ) {
      return
    }
    setBusyAll(true)
    setError(null)
    const batch = [...proposals]
    for (const p of batch) proposalInFlightRef.current.add(p.id)
    setProposals([])
    let ok = 0
    let failed = 0
    const failedItems: EntityProposalView[] = []
    try {
      for (const p of batch) {
        const title = (draftTitles[p.id] ?? p.suggested_name).trim()
        if (!title) {
          failed += 1
          failedItems.push(p)
          proposalInFlightRef.current.delete(p.id)
          continue
        }
        try {
          const matchId = p.suggested_match?.id || p.matched_entity_id
          if (matchId && profiles.some((x) => x.id === matchId)) {
            await api.approveProjectProposal(p.id, {
              title,
              matched_entity_id: matchId,
              as: 'link',
            })
          } else {
            await api.approveProjectProposal(p.id, {
              title,
              category: draftCategories[p.id] ?? 'proyecto',
              status: draftStatuses[p.id] ?? 'emergente',
              tactical_focus: draftFocuses[p.id] || undefined,
              as: 'create',
            })
          }
          ok += 1
        } catch {
          failed += 1
          failedItems.push(p)
        } finally {
          proposalInFlightRef.current.delete(p.id)
        }
      }
      if (failedItems.length > 0) {
        setProposals((prev) => [...failedItems, ...prev])
      }
      onChanged?.()
      setStatusMsg(
        failed > 0
          ? `Resueltas ${ok} · fallaron ${failed}`
          : `Resueltas ${ok} propuestas`,
      )
    } finally {
      setBusyAll(false)
    }
  }

  const handleExportAll = async () => {
    if (profiles.length === 0) return
    try {
      const payload = await api.exportProjects()
      const day = new Date().toISOString().slice(0, 10)
      downloadJson(`deprocast-proyectos-${day}.json`, payload)
      setStatusMsg(`Exportados ${payload.count} proyectos`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al exportar')
    }
  }

  const handleLinkPerson = async () => {
    if (!editingId || !personPick) return
    try {
      await api.linkPersonToProject(personPick, {
        project_id: editingId,
        role: personRole,
      })
      setPersonPick('')
      const data = await api.getProject(editingId)
      setPeople(data.people ?? [])
      setStatusMsg('Persona vinculada')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al vincular persona')
    }
  }

  const handleUnlinkPerson = async (linkId: string) => {
    if (!editingId) return
    try {
      await api.unlinkPersonFromProject(linkId)
      const data = await api.getProject(editingId)
      setPeople(data.people ?? [])
      setStatusMsg('Persona desvinculada')
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al desvincular')
    }
  }

  return (
    <div className={embedded ? 'entity-stage-body' : 'entity-stage personas-stage'}>
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
            {validatorOpen && proposals.length > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-tiny"
                disabled={busyAll}
                onClick={() => void handleApproveAll()}
              >
                Aprobar todo
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
                const match = p.suggested_match
                const busy = busyId === p.id || busyAll
                return (
                  <li key={p.id} className="proposal-card">
                    <div className="proposal-card-head">
                      <span
                        className={
                          match ? 'badge badge-link' : 'badge badge-new'
                        }
                      >
                        {match ? 'Posible vínculo' : 'Mención'}
                      </span>
                    </div>
                    <label className="field">
                      <span className="mono">Título</span>
                      <input
                        value={draftTitles[p.id] ?? p.suggested_name}
                        onChange={(e) =>
                          setDraftTitles((d) => ({
                            ...d,
                            [p.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="mono">Tipo</span>
                      <select
                        value={draftCategories[p.id] ?? 'proyecto'}
                        onChange={(e) =>
                          setDraftCategories((d) => ({
                            ...d,
                            [p.id]: e.target.value as ProjectKind,
                          }))
                        }
                      >
                        <option value="proyecto">Proyecto</option>
                        <option value="tarea">Tarea / reto</option>
                        <option value="concepto">Concepto</option>
                      </select>
                    </label>
                    <label className="field">
                      <span className="mono">Estado</span>
                      <select
                        value={draftStatuses[p.id] ?? 'emergente'}
                        onChange={(e) =>
                          setDraftStatuses((d) => ({
                            ...d,
                            [p.id]: e.target.value as ProjectStatus,
                          }))
                        }
                      >
                        <option value="activo">Activo</option>
                        <option value="pausado">Pausado</option>
                        <option value="cerrado">Cerrado</option>
                        <option value="emergente">Emergente</option>
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
                        onClick={() => void handleReject(p.id)}
                      >
                        Descartar
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-tiny"
                        disabled={busy}
                        onClick={() => void handleCreateNew(p)}
                      >
                        A sala de espera
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ))}
      </section>

      <div className="personas-layout">
        <section className="panel entity-panel profiles-directory">
          <div className="panel-head entity-head">
            <div>
              <h2>Proyectos</h2>
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
                Nuevo
              </button>
            </div>
          </div>

          {loading && profiles.length === 0 ? (
            <p className="muted mono">Cargando…</p>
          ) : profiles.length === 0 ? (
            <p className="muted mono profiles-empty">
              Sin maestros. Creá uno o promové desde la sala de espera.
            </p>
          ) : (
            <>
              <div className="profiles-toolbar">
                <div
                  className="filter-rail"
                  role="tablist"
                  aria-label="Filtrar por tipo"
                >
                  {(
                    [
                      ['all', 'Todos'],
                      ['proyecto', 'Proyecto'],
                      ['tarea', 'Tarea'],
                      ['concepto', 'Concepto'],
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
                    placeholder="Buscar por título o alias…"
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
                      {initials(p.title)}
                    </span>
                    <span className="profile-card-body">
                      <span className="profile-card-name">{p.title}</span>
                      <span className="profile-card-meta mono">
                        {KIND_LABEL[normalizeProjectKind(p.category)]}
                        {semanticScores[p.id] != null
                          ? ` · ${Math.round(semanticScores[p.id]! * 100)}%`
                          : ''}
                        {typeof p.person_count === 'number' &&
                        p.person_count > 0
                          ? ` · ${p.person_count} personas`
                          : ''}
                        {typeof p.link_count === 'number'
                          ? ` · ${p.link_count} fuentes`
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
                  ? 'Promover a maestro'
                  : editingId
                    ? 'Inspector'
                    : 'Alta manual'}
              </h3>
              <label className="field">
                <span className="mono">Título</span>
                <input
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  placeholder="Nombre canónico"
                />
              </label>
              <label className="field">
                <span className="mono">Tipo</span>
                <select
                  value={formCategory}
                  onChange={(e) =>
                    setFormCategory(e.target.value as ProjectKind)
                  }
                >
                  <option value="proyecto">Proyecto</option>
                  <option value="tarea">Tarea / reto</option>
                  <option value="concepto">Concepto</option>
                </select>
              </label>
              <label className="field">
                <span className="mono">Estado</span>
                <select
                  value={formStatus}
                  onChange={(e) =>
                    setFormStatus(e.target.value as ProjectStatus)
                  }
                >
                  <option value="activo">Activo</option>
                  <option value="pausado">Pausado</option>
                  <option value="cerrado">Cerrado</option>
                  <option value="emergente">Emergente</option>
                </select>
              </label>
              <label className="field">
                <span className="mono">Aliases</span>
                <input
                  value={formAliases}
                  onChange={(e) => setFormAliases(e.target.value)}
                  placeholder="depro, terreta, procast"
                />
              </label>
              <label className="field">
                <span className="mono">Enfoque táctico</span>
                <input
                  value={formFocus}
                  onChange={(e) => setFormFocus(e.target.value)}
                  placeholder="Prioridad / vector"
                />
              </label>
              <label className="field">
                <span className="mono">Notas</span>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={3}
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
                  disabled={!formTitle.trim()}
                  onClick={() => void handleSave()}
                >
                  {promoteId
                    ? 'Confirmar promoción'
                    : editingId
                      ? 'Guardar'
                      : 'Registrar'}
                </button>
              </div>

              {editingId && !promoteId && (
                <div className="relation-block">
                  <h4 className="mono">Personas vinculadas</h4>
                  <div className="relation-add">
                    <select
                      value={personRole}
                      onChange={(e) =>
                        setPersonRole(e.target.value as PersonProjectRole)
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
                      value={personPick}
                      onChange={(e) => setPersonPick(e.target.value)}
                    >
                      <option value="">— persona —</option>
                      {persons.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-tiny btn-primary"
                      disabled={!personPick}
                      onClick={() => void handleLinkPerson()}
                    >
                      Vincular
                    </button>
                  </div>
                  {people.length === 0 ? (
                    <p className="muted mono">Sin personas</p>
                  ) : (
                    <ul className="item-edit-list">
                      {people.map((pe) => (
                        <li key={pe.id} className="mono relation-row">
                          <span>
                            {ROLE_LABEL[pe.role as PersonProjectRole] ??
                              pe.role}{' '}
                            · {pe.person_name}
                          </span>
                          <button
                            type="button"
                            className="btn btn-tiny btn-ghost danger"
                            onClick={() => void handleUnlinkPerson(pe.id)}
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
            </div>
          )}
        </section>

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
                Menciones validadas sin maestro
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
                    Ctrl+clic para multiselección · arrastrá al maestro
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
                            const t = e.target as HTMLElement
                            if (
                              t.closest('button, select, input, .waiting-hint')
                            ) {
                              return
                            }
                            e.preventDefault()
                            toggleWaitingSelect(w.id, e.ctrlKey || e.metaKey)
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
                              {w.title}
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

                          {match && (
                            <button
                              type="button"
                              className="btn btn-tiny btn-match"
                              disabled={busy || profiles.length === 0}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                void handleAttach(w.id, match.id)
                              }}
                            >
                              ¿Vincular a {match.name}? (
                              {Math.round(match.score * 100)}%)
                            </button>
                          )}

                          <div className="waiting-pill-actions">
                            {profiles.length > 0 ? (
                              <select
                                className="waiting-link-select"
                                defaultValue={match?.id ?? ''}
                                disabled={busy}
                                aria-label="Vincular a proyecto"
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
                                    {p.title}
                                    {match?.id === p.id
                                      ? ` · ${Math.round(match.score * 100)}%`
                                      : ''}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="waiting-link-placeholder muted mono">
                                Sin maestros
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
                              Promover a maestro
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
          projectId={selectedId}
          refreshKey={refreshKey}
          onLinked={() => {
            void load()
            if (selectedId) void selectProfile(selectedId)
            onChanged?.()
          }}
        />
        </div>
      </div>

      {statusMsg && <p className="status-line ok">{statusMsg}</p>}
      {error && <p className="status-line err">{error}</p>}

      <NerValidationDeck
        open={deckOpen}
        onClose={() => setDeckOpen(false)}
        variant="project"
        proposals={proposals}
        names={draftTitles}
        classes={draftCategories}
        classOptions={[
          { value: 'proyecto', label: 'Proyecto' },
          { value: 'tarea', label: 'Tarea / reto' },
          { value: 'concepto', label: 'Concepto' },
        ]}
        onNameChange={(id, value) =>
          setDraftTitles((d) => ({ ...d, [id]: value }))
        }
        onClassChange={(id, value) =>
          setDraftCategories((d) => ({
            ...d,
            [id]: normalizeProjectKind(value),
          }))
        }
        onDiscard={async (p) => {
          await handleReject(p.id)
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
