# Mnemosyne — vectorización en Deprocast

Mnemosyne es la capa de **memoria semántica** de Deprocast: convierte texto validado en vectores densos (embeddings) para relacionar fuentes, quántomos, personas y proyectos más allá del matching léxico.

## Flujo general

```
Zona franca (audio)
    → Pipeline (Deepgram STT + Cohere extract)
    → Aduana HITL (quántomos / tareas)
    → approve
         ├─ entity_proposals (Personas / Proyectos)
         └─ embed entry + quantomos   ← Mnemosyne
Personas / Proyectos HITL
    → approve create | link
         ├─ persons / projects + entity_links
         └─ embed person|project + link_context
CRUD manual
    → create / update
         └─ re-embed entidad
```

La vectorización **no ocurre** sobre borradores de Aduana. Solo se embebe lo ya reconocido (entry aprobada, quántomos `recognized=1`, personas/proyectos validados y contextos de vínculo).

## Qué se vectoriza

| `object_type`   | Contenido típico                                      | Cuándo                         |
|-----------------|--------------------------------------------------------|--------------------------------|
| `entry`         | título + transcript                                    | Tras approve en Aduana         |
| `quantomo`      | título + contenido del quántomo                        | Tras approve en Aduana         |
| `person`        | nombre, tipo, aliases, notas                           | Create/update / approve HITL   |
| `project`       | título, categoría, estado, enfoque, notas              | Create/update / approve HITL   |
| `link_context`  | entidad + título de fuente + snippet de evidencia     | Al aprobar create/link         |

## Modelo y API

- Proveedor: **Cohere Embed** (`POST https://api.cohere.com/v2/embed`)
- Modelo: `COHERE_EMBED_MODEL` (por defecto `embed-v4.0`)
- Auth: `COHERE_API_KEY`
- Throttle: `COHERE_REQUEST_DELAY_MS` (compartido con el extractor)
- `input_type`:
  - `search_document` al indexar
  - `search_query` al buscar

Si falta la API key o la llamada falla, Mnemosyne **no bloquea** el HITL: registra un warning y continúa (mismo patrón que STT/extract stubs).

Implementación: [`server/services/embeddings.ts`](server/services/embeddings.ts).

## Persistencia (SQLite)

Tabla `embeddings`:

| Columna       | Rol                                              |
|---------------|--------------------------------------------------|
| `object_type` | Tipo de objeto (ver tabla arriba)                |
| `object_id`   | UUID del objeto                                  |
| `model`       | Nombre del modelo usado                          |
| `dims`        | Dimensionalidad del vector                       |
| `vector`      | JSON `number[]`                                  |
| `text_hash`   | SHA-256 del texto embebido                       |
| `created_at`  | ISO timestamp                                    |

Constraint único: `(object_type, object_id, model)`.

### Idempotencia

Antes de llamar a Cohere, se calcula `text_hash`. Si ya existe un embedding para el mismo objeto/modelo con el mismo hash, **se omite** la llamada. Si el texto cambió (edición de ficha, re-approve), se re-embebe y se actualiza la fila.

## Búsqueda local

No hay vector DB externa en v1. `searchSimilar(query, { types, limit })`:

1. Embebe la query (`search_query`)
2. Carga vectores candidatos desde SQLite (filtrados por tipo/modelo)
3. Calcula **cosine similarity** en Node
4. Devuelve top-N ordenados por score

Pensado para volúmenes local-first. Si el corpus crece mucho, el siguiente paso natural sería sqlite-vss / una store dedicada, sin cambiar el contrato de `object_type` / `object_id`.

## Relación con Personas y Proyectos

1. El pipeline guarda menciones crudas en `entry_entities_raw` (person/project).
2. Al aprobar en Aduana, `entityMatch` coteja nombre (normalizado, sin acentos) + aliases y crea `entity_proposals` (`create` o `link`).
3. El operador valida en las secciones Personas / Proyectos.
4. Al aprobar:
   - `create` materializa la entidad y un `entity_link` a la entry
   - `link` solo crea el vínculo a una entidad existente
5. Mnemosyne embebe la entidad y un `link_context` con el snippet de evidencia, para que menciones futuras se relacionen semánticamente con la ficha y la fuente.

Así el grafo relacional (`entity_links`) y el espacio vectorial (`embeddings`) avanzan juntos: el vínculo es explícito; el embedding permite recuperación aproximada.

## Variables de entorno

```env
COHERE_API_KEY=
COHERE_EMBED_MODEL="embed-v4.0"
COHERE_REQUEST_DELAY_MS="2000"
# Preparado, aún no cableado en Mnemosyne v1:
COHERE_RERANK_MODEL="rerank-v3.5"
```

## Límites de esta versión

- Sin UI de búsqueda semántica global (la API `searchSimilar` está lista en servidor).
- Sin rerank.
- Vectores como JSON en SQLite (simple, portable; no óptimo a escala masiva).
- Sin re-embed automático de entries antiguas al cambiar de modelo: un cambio de `COHERE_EMBED_MODEL` indexa objetos nuevos/editados bajo el modelo nuevo; los viejos quedan hasta re-procesarlos.
