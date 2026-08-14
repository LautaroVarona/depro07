import { Router } from 'express'
import {
  listRecentEntities,
  typeaheadEntities,
  type TypeaheadKind,
} from '../services/typeahead.js'

export const entitiesRouter = Router()

const KIND_SET = new Set<TypeaheadKind>([
  'person',
  'project',
  'quantomo',
  'agrupacion',
])

entitiesRouter.get('/typeahead', (req, res) => {
  const q = String(req.query.q ?? '').trim()

  const kindsRaw = String(req.query.kinds ?? 'person,project')
  const kinds = kindsRaw
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k): k is TypeaheadKind => KIND_SET.has(k as TypeaheadKind))

  const limitRaw = Number(req.query.limit ?? 10)
  const limit = Number.isFinite(limitRaw) ? limitRaw : 10

  const scopeRaw = String(req.query.scope ?? 'masters').toLowerCase()
  const scope = scopeRaw === 'all' ? 'all' : 'masters'

  const resolvedKinds = kinds.length ? kinds : (['person', 'project'] as TypeaheadKind[])

  const results = q
    ? typeaheadEntities(q, { kinds: resolvedKinds, limit, scope })
    : listRecentEntities(resolvedKinds, limit)

  res.json({ query: q, results })
})
