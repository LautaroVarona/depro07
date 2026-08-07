# Deprocast — Reporte técnico (2026-08-07)

Documento de contexto para otras IAs / operadores. Describe el **estado real del código** (no el diseño aspiracional), con huecos, trampas conocidas y puntos de extensión.

---

## 1. Qué es

**Deprocast** es un exoesqueleto local-first de captura → validación HITL → CRM semántico → grafo. Flujo mental del producto:

1. Grabás audios (caminatas / notas).
2. El pipeline los transcribe (Deepgram) y extrae quántomos / tareas / entidades (Cohere).
3. **Aduana** valida HITL.
4. **Personas / Proyectos** consolidan el roster (maestros vs sala de espera).
5. **Mnemosyne** embebe lo aprobado.
6. **Grafo** visualiza personas, proyectos, quántomos y aristas (confirmadas, sugeridas, órbita, semánticas).

Versión conceptual: entorno **v0.7.x**. No hay Prisma: SQLite nativo.

---

## 2. Stack

| Capa | Tecnología |
|------|------------|
| Frontend | React 19, Vite 6, TypeScript, Tailwind 4, `react-force-graph-2d` |
| Backend | Express 4, `tsx`, Multer, CORS, dotenv |
| DB | SQLite vía `node:sqlite` (`DatabaseSync`), WAL → `data/deprocast.db` |
| STT | Deepgram |
| LLM / Embed | Cohere Chat v2 + Embed v4 |
| Dev | `npm run dev` → `scripts/dev.mjs` (API `:3001` + Vite `:5173` con proxy) |

**Nota entorno Windows:** Node no está en PATH global del usuario; usar:

```bat
set PATH=C:\Users\Lautaro.Sarni\bin\node-v24.18.0-win-x64;%PATH%
```

---

## 3. Mapa de carpetas

```
deprocast/
  src/                  # UI React (App.tsx = router por vista)
  server/
    index.ts            # Express mount
    db.ts               # schema + migrate() + aliases sync
    routes/             # HTTP delgado
    services/           # pipeline, cohere, embeddings, graph, matchmakers
  vault/                # audio por entryId
  data/deprocast.db     # SQLite real
  vector.md             # diseño Mnemosyne
  v0.7.1.md             # arquitectura (parcialmente desactualizado vs código)
  .env / .env.example
```

Vistas UI (`src/App.tsx`): `franca` | `aduana` | `validada` | `personas` | `proyectos` | `quantomos` | `grafo`.

---

## 4. Pipeline de datos (fuente de verdad)

```
POST /api/ingest/audio
  → vault/<entryId>/<file> + entries(status=queued)
  → pipeline: STT (Deepgram) → extract (Cohere)
  → quantomos + pending_tasks + entry_entities_raw
  → entries.status = pending_review

Aduana GET/POST /api/proposals
  → approve: recognized quantomos, createEntityProposalsFromEntry, embedApprovedEntry
  → reject

Personas/Proyectos HITL
  → create | link → persons/projects + entity_links + embed person/project/link_context

Grafo
  → GET /api/graph (snapshot)
  → GET /api/graph/discover (co-ocurrencia)
  → POST /api/graph/link-hitl (HITL persona↔proyecto)
  → GET /api/graph/search (zoom GraphRAG)
```

**Regla Mnemosyne:** no se embebe borrador de Aduana; solo lo validado (`vector.md`).

---

## 5. Modelo de datos (SQLite)

Tablas relevantes (creadas/migradas en `server/db.ts`):

| Tabla | Rol |
|-------|-----|
| `notebooks`, `entries` | Fuentes (audio) |
| `quantomos` | Partículas (`hermetic_weight` ~1–10/12, `recognized`) |
| `pending_tasks` | Acciones extraídas |
| `persons`, `projects` | CRM (maestros `source=manual`; waiting `extractor` + `merged_into`) |
| `entity_proposals` | HITL create/link post-Aduana |
| `entity_links` | entidad ↔ entry [/quantomo] |
| `person_project_links` | M2M persona↔proyecto (`UNIQUE(person_id,project_id)`) |
| `person_relations` | persona↔persona |
| `entity_aliases`, `project_aliases` | índice de alias (`UNIQUE` norm) |
| `embeddings` | vectores JSON + `text_hash` SHA-256 |
| `graph_link_dismissals` | sugerencias descartadas |
| `validated_file_metadata` | snapshot al validar |

**No hay Prisma.** `.env` puede tener `DATABASE_URL` remnant; **no se usa**.

---

## 6. APIs montadas (`server/index.ts`)

- `/api/health`
- `/api/ingest`
- `/api/entries`
- `/api/pipeline`
- `/api/proposals`
- `/api/persons`
- `/api/projects`
- `/api/quantomos`
- `/api/graph` — `/`, `/discover`, `/dismiss`, `/link-hitl`, `/search`

Función **`searchGraphContext(query)`** existe en `server/services/graph.ts` (GraphRAG para Mastropiero) pero **no tiene endpoint HTTP** todavía.

---

## 7. Grafo / Mnemosyne — estado actual

### Backend (`server/services/embeddings.ts`, `graph.ts`)

- Embeddings Cohere + cosine in-process + idempotencia `text_hash`.
- Snapshot: personas, proyectos, quántomos (hasta 1200), huérfanos (proposals pending).
- Links: `confirmed` | `suggested` | `orbit` (quantomo→maestro) | `semantic` (invisible, fuerza).
- Heatmap diario + `time_range` (con clamp anti-outliers).
- `discoverLinks` = co-ocurrencia por `entry_id` sin `person_project_links`.
- Fechas: se ignoran `timestamp_exact` absurdos (`< 2024` o `>= 2030`); se cae a `created_at`.

### Frontend (`src/components/GraphSection.tsx`)

- Lienzo full-bleed + HUD capas + command palette + drawer inspección + settings (`localStorage` key `deprocast.graph.settings.v1`).
- Hexágonos (person/project), estrellas (quantomo), rojo (orphan).
- Túnel focus 1–2 hops, God-mode (pin operator + anillos).
- Scrubber inferior + histograma.
- Modos temporales:
  - **`growth` (default):** muestra nodos con `first_seen <= día` (crecimiento acumulado).
  - **`momentum`:** solo nodos activos ese día (`first_seen <= día <= last_seen`).

### Bug corregido el 2026-08-07 (canvas vacío)

**Síntoma:** canvas azul/vacío, timeline `7 jul 1995` → `1 dic 2026`, Quántomos “encendidos” pero invisibles.

**Causa:**

1. Un entry con `timestamp_exact = 1995-07-07` ensuciaba el rango.
2. El slider arrancaba en el máximo (`2026-12-01`).
3. El filtro era **momentum estricto**: solo nodos con `last_seen >= ese día`. Casi nadie (ni quántomos) estaba “activo” el 1-dic → grafo vacío.

**Fix:** clamp de fechas, heatmap/time_range saneados, modo default `growth`, arranque en último día del heatmap, empty-state + reset filtros, zoomToFit tras cargar, saneo de color de fondo claro en settings.

---

## 8. Conteos orientativos (DB local al reportar)

| Entidad | Orden de magnitud |
|---------|-------------------|
| Quántomos | ~800 (`recognized` ~793) |
| Personas no merged | ~49 |
| Proyectos maestros (`manual`) | ~14 |
| Proyectos merged/extractor | ~380 |
| Entries | cientos; fechas útiles mayormente 2026-03 → 2026-08 |

Datos en `data/deprocast.db` + media en `vault/`.

---

## 9. Qué está sólido

- Pipeline audio → Aduana → CRM HITL.
- Matchmakers persona/proyecto (fuzzy + cosine).
- Mnemosyne post-approve + búsqueda semántica en Persons/Projects.
- Co-ocurrencia HITL + bandeja de enlaces sugeridos.
- Base del grafo visual (force-graph + capas + settings persistentes).
- Export JSON de perfiles/proyectos.

---

## 10. Gaps / deuda (prioridad sugerida)

### P0 — producto inmediato

1. **Chat Mastropiero:** UI + cablear `searchGraphContext` a un endpoint `/api/graph/context` + Cohere chat.
2. **Estabilidad grafo:** performance con ~800 quántomos (LOD, clustering visual, no pintar labels siempre).
3. **Drag huérfano → proyecto:** esbozado; falta cerrar el circuito HITL (proposal approve / attach) de forma fiable.
4. **Timestamps basura:** además del clamp, UI/pipeline debería corregir `timestamp_exact` absurdos al validar.

### P1 — recuperación táctica

5. **Búsqueda híbrida BM25/FTS5 + dense + Cohere Rerank** (`COHERE_RERANK_MODEL` ya en env, no cableado).
6. **Weak edges** quantomo↔proyecto por umbral cosine (diseño original Fase 2, no hecho).
7. **Time decay** en ranking (diseño tips, no hecho).

### P2 — aspiracional

8. Clustering Leiden/Louvain / DBSCAN.
9. Transformers.js local-first (sin créditos).
10. OCR / vision (`COHERE_VISION_MODEL` declarado, sin código; ingest solo audio).
11. Grafo 3D / WebGL avanzado.

### Docs desactualizados

- `v0.7.1.md` aún marca cableados pendientes que **ya están** en código (proposals → embed, CRM routes). Contrastar siempre con `server/` + `src/`.

---

## 11. Archivos clave para extender

| Objetivo | Archivo |
|----------|---------|
| Schema / migrate | `server/db.ts` |
| Pipeline | `server/services/pipeline.ts`, `cohere.ts`, `deepgram.ts` |
| Embeddings | `server/services/embeddings.ts` |
| Grafo API/logic | `server/services/graph.ts`, `server/routes/graph.ts` |
| UI grafo | `src/components/GraphSection.tsx`, `src/lib/graphSettings.ts` |
| Cliente HTTP | `src/services/api.ts` |
| Tipos cliente | `src/types.ts` |
| Diseño vectores | `vector.md` |

---

## 12. Convenciones para IAs que toquen el repo

1. **No introducir Prisma.** Seguir `node:sqlite` + `migrate()` en `db.ts`.
2. **No rehacer Mnemosyne:** reutilizar `upsertEmbedding` / `searchSimilar` / `cosineSimilarity`.
3. Imports ESM con sufijo `.js` en server (`from './x.js'`).
4. Respuestas al usuario en **español**.
5. No commitear ni tocar `.env` con secretos.
6. Node: prefix PATH portable antes de `npm`/`npx`.
7. Preferir cambios mínimos alineados al patrón rutas delgadas + services.
8. El grafo filtra por capas + tiempo: si “no se ve nada”, mirar **primero** `timeMode`, `timeDay` y outliers de `timestamp_exact`.

---

## 13. Variables de entorno (nombres)

`PORT`, `DEEPGRAM_*`, `COHERE_API_KEY`, `COHERE_MODEL`, `COHERE_MODEL_FAST`, `COHERE_VISION_MODEL`, `COHERE_EMBED_MODEL`, `COHERE_RERANK_MODEL`, `COHERE_REQUEST_DELAY_MS`.

Ver `.env.example`.

---

## 14. Cómo arrancar

```bat
set PATH=C:\Users\Lautaro.Sarni\bin\node-v24.18.0-win-x64;%PATH%
cd c:\Users\Lautaro.Sarni\dev\deprocast
npm run dev
```

UI: `http://localhost:5173` · API: `http://localhost:3001/api/health`.

Tras cambios de grafo: hard refresh; si el canvas sigue raro, Settings → reset colores, o borrar `localStorage['deprocast.graph.settings.v1']`, y **Reset filtros** en empty-state.

---

## 15. Resumen ejecutivo

Deprocast ya no es un prototipo vacío: **pipeline + Aduana + CRM + embeddings + grafo HITL** están cableados. El cuello de botella actual es **producto del grafo** (claridad, rendimiento con cientos de quántomos, chat GraphRAG) y **calidad de timestamps**, no la ausencia de backend. La siguiente gran pieza de valor es **Mastropiero** (chat + `searchGraphContext`) y la búsqueda híbrida.

*Generado 2026-08-07 como contexto operativo para continuidad entre agentes.*
