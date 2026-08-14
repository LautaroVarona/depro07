# Instagram Reels en Deprocast (Criba)

Canal paralelo a los bookmarks de Twitter/X: reels que te mandás a vos mismo en Instagram, importados como JSON, cribados con el mismo teclado 1–12, y procesados por bandas de peso.

## Origen

Durante años, el operador se mandó reels por DM a sí mismo como “guardar para después”. El export (`ig_export.json`) es un array de partículas:

```ts
interface IgReelParticle {
  id: number              // orden del chat; NO es PK estable
  url_video: string       // página del reel (instagram.com/reel/…)
  descripcion_reel: string
  autor: string
  likes: number
  comments: number
  fecha_mensaje: string   // ISO del mensaje en el chat
  shortcode: string       // id estable del reel
  media_pk: string
}
```

En Deprocast la PK es `ig:<shortcode>`.

## Flujo

```
ig_export.json
  → Import en Criba (dropzone)
  → Bookmarks source=instagram, status=PENDIENTE_CRIBA
  → HITL flashcard (video | descripción) + teclas 1–12
  → status=CRIBADO + weight
  → “Procesar validados”
      1–3  → SLOP
      4–6  → texto → título 1–3 palabras → quantomo + NER + suggested links
      7–9  → lo anterior + yt-dlp + Deepgram STT + resumen audio
     10–12 → lo anterior + ffmpeg frames ~3s + Cohere Vision + video_meta
  → Aprobar quantomos (recognized=1) → embeddings
```

Twitter/X sigue igual: puntuar + proceso solo si `weight >= 7` (texto, sin audio/OCR).

## Import

Misma dropzone que Twitter. El backend detecta shape IG (`descripcion_reel` + `url_video`/`shortcode`) y segmenta `source`.

- Endpoint: `POST /api/bookmarks/import` (multipart `file`, `{ raw }`, o `{ items }`)
- Respuesta incluye `detected_source`: `instagram` | `twitter` | `mixed`
- Dedup por `ig:<shortcode>`; reimport de pendientes actualiza campos

## HITL (flashcard)

- Layout dos columnas: **video** (autoplay muted/loop) | **descripción**
- Contador: `Procesando N de T` mientras hay pendientes
- Filtro de fuente: Todos | Twitter | Instagram
- Teclas (igual que Twitter):
  - `1`–`9` → peso 1–9
  - `0` / `q` → 10
  - `.` / `'` / `w` → 11
  - `Enter` / `¡` / `e` → 12
- Al puntuar avanza solo a la siguiente partícula
- El video se descarga **lazy** al abrir la flashcard (`POST /api/bookmarks/:id/ensure-media`) y se sirve en `GET /api/bookmarks/:id/media`

Si yt-dlp falla, se puede votar igual y abrir el link de Instagram.

## Bandas de proceso (solo Instagram)

| Peso | Status / resultado |
|------|--------------------|
| 1–3 | `SLOP` — sin entry ni quantomo |
| 4–6 | Entry `source_type=instagram` + quantomo + NER + propuestas de vínculo |
| 7–9 | + descarga local + transcripción Deepgram + `audio_summary` |
| 10–12 | + fotogramas cada ~3s (máx. 20) + explicación Vision por frame + `video_meta` |

Campos de enrichment en `bookmarks`: `local_media_path`, `transcript`, `ocr_json`, `enrichment_json`.

## Dependencias externas

| Tool | Uso |
|------|-----|
| **yt-dlp** | Descargar el reel desde la URL de página |
| **ffmpeg** | Extraer fotogramas (bandas 10–12) y apoyo de media |
| **Deepgram** | STT del video (`DEEPGRAM_API_KEY`) |
| **Cohere** | Extracción / título / NER (`COHERE_*`); Vision (`COHERE_VISION_MODEL`) |

### Instalar yt-dlp (Windows)

El server busca, en orden:

1. Variable `YT_DLP_PATH`
2. `tools/yt-dlp.exe` (en el repo)
3. `%USERPROFILE%\bin\yt-dlp.exe` (junto a tu Node portable)
4. `yt-dlp` en el PATH

Descarga el exe oficial:

```powershell
Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile "$env:USERPROFILE\bin\yt-dlp.exe"
# opcional copia local:
Copy-Item "$env:USERPROFILE\bin\yt-dlp.exe" .\tools\yt-dlp.exe
```

Reiniciá el server después de instalarlo. Si la descarga local falla, la flashcard usa el **embed de Instagram** para poder puntuar igual; STT/OCR (bandas 7–12) sí necesitan el archivo local.

Media local: `vault/instagram/<id>/` (gitignored).

## Diferencias vs Twitter

| | Twitter | Instagram |
|--|---------|-----------|
| Import | CSV/JSON tweets | `ig_export.json` reels |
| ID | tweet id | `ig:shortcode` |
| UI | texto + imágenes | flashcard video \| desc |
| Proceso | solo ≥7, texto | bandas 1–12 |
| Media | URLs ornamentales | yt-dlp → vault |
| Entry `source_type` | `bookmark` | `instagram` |

## Limitaciones

- `url_video` es página web, no CDN directo: la descarga depende de yt-dlp y de Instagram (rate limits, login, cambios de HTML).
- Descargar cientos de reels en HITL puede ser lento; el import en sí es inmediato.
- Vision por fotograma es costoso; se limita a 20 frames.
- OCR (banda 10–12) necesita **ffmpeg** en `tools/ffmpeg.exe`, `%USERPROFILE%\bin\ffmpeg.exe`, o `FFMPEG_PATH` (con sus DLLs si es build shared).
- Si un ítem ya salió `PROCESADO_IA` sin frames: Criba → Procesado → **Reprocesar OCR** (uno o batch). Endpoints: `POST /api/bookmarks/:id/reprocess-ocr` y `POST /api/bookmarks/reprocess-ocr`.
- Mejorar el export (URLs de media directas) reduciría dependencia de yt-dlp.

## Archivos clave

- `server/services/bookmarkProcess.ts` — normalize IG + process bands + reprocess OCR
- `server/services/instagramMedia.ts` — yt-dlp + ffmpeg frames
- `server/services/cohere.ts` — `extractFromInstagramReel`, `explainVideoFrame`
- `server/routes/bookmarks.ts` — import, media, counts por fuente, reprocess-ocr
- `src/components/CribaPanel.tsx` — flashcard + filtro fuente + botón OCR
