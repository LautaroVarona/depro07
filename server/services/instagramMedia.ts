/**
 * Descarga reels de Instagram con yt-dlp y sirve paths locales en vault/.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../db.js'
import { row } from '../sql.js'
import type { Bookmark } from '../types.js'

const VAULT_IG = path.resolve(process.cwd(), 'vault', 'instagram')

export type EnsureMediaResult =
  | { ok: true; absPath: string; relativePath: string }
  | { ok: false; error: string }

function safeIdDir(bookmarkId: string): string {
  return bookmarkId.replace(/[^a-zA-Z0-9:_-]/g, '_').replace(/:/g, '_')
}

export function instagramVaultDir(bookmarkId: string): string {
  return path.join(VAULT_IG, safeIdDir(bookmarkId))
}

function runCmd(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      windowsHide: true,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    const timer =
      opts?.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error(`${path.basename(cmd)} timeout ${opts.timeoutMs}ms`))
          }, opts.timeoutMs)
        : null
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

function ytDlpCandidates(): string[] {
  const home = os.homedir()
  const fromEnv = process.env.YT_DLP_PATH?.replace(/^["']|["']$/g, '').trim()
  const here = path.resolve(process.cwd())
  const fromModule = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'tools',
    'yt-dlp.exe',
  )
  return [
    ...(fromEnv ? [fromEnv] : []),
    path.join(here, 'tools', 'yt-dlp.exe'),
    path.join(here, 'tools', 'yt-dlp'),
    fromModule,
    path.join(home, 'bin', 'yt-dlp.exe'),
    path.join(home, 'bin', 'yt-dlp'),
    'yt-dlp',
    'yt-dlp.exe',
  ]
}

let cachedYtDlp: string | null = null

async function whichYtDlp(): Promise<string> {
  if (cachedYtDlp && fs.existsSync(cachedYtDlp)) return cachedYtDlp

  const tried: string[] = []
  for (const c of ytDlpCandidates()) {
    const isAbs = path.isAbsolute(c) || /[\\/]/.test(c)
    if (isAbs && !fs.existsSync(c)) {
      tried.push(`${c} (missing)`)
      continue
    }
    // Path absoluto existente: confiar sin --version (en Win el cold start
    // puede superar 8s por Defender y el timeout falso “no encontrado”).
    if (isAbs && fs.existsSync(c)) {
      cachedYtDlp = c
      console.log(`[ig-media] yt-dlp → ${c}`)
      return c
    }
    try {
      const r = await runCmd(c, ['--version'], { timeoutMs: 45_000 })
      if (r.code === 0) {
        cachedYtDlp = c
        console.log(`[ig-media] yt-dlp → ${c} (${r.stdout.trim()})`)
        return c
      }
      tried.push(`${c} (exit ${r.code})`)
    } catch (err) {
      tried.push(
        `${c} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  console.error('[ig-media] candidatos yt-dlp:', tried.join(' | '))
  throw new Error(
    'yt-dlp no encontrado. Poné yt-dlp.exe en tools/ o en %USERPROFILE%\\bin, o definí YT_DLP_PATH.',
  )
}

function findDownloadedVideo(dir: string): string | null {
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir)
  const video = files.find((f) =>
    /\.(mp4|webm|mkv|mov|m4v)$/i.test(f),
  )
  return video ? path.join(dir, video) : null
}

/**
 * Asegura video local para un bookmark IG. Actualiza local_media_path en DB.
 */
export async function ensureReelMedia(
  bookmark: Pick<Bookmark, 'id' | 'link' | 'local_media_path' | 'source'>,
): Promise<EnsureMediaResult> {
  if (bookmark.local_media_path) {
    const abs = path.resolve(process.cwd(), bookmark.local_media_path)
    if (fs.existsSync(abs)) {
      return { ok: true, absPath: abs, relativePath: bookmark.local_media_path }
    }
  }

  const url = (bookmark.link || '').trim()
  if (!url || !/instagram\.com/i.test(url)) {
    return { ok: false, error: 'URL de Instagram inválida o vacía' }
  }

  const dir = instagramVaultDir(bookmark.id)
  fs.mkdirSync(dir, { recursive: true })

  const existing = findDownloadedVideo(dir)
  if (existing) {
    const relativePath = path
      .relative(process.cwd(), existing)
      .replace(/\\/g, '/')
    persistLocalPath(bookmark.id, relativePath)
    return { ok: true, absPath: existing, relativePath }
  }

  let ytDlp: string
  try {
    ytDlp = await whichYtDlp()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ig-media]', msg)
    return { ok: false, error: msg }
  }

  const outTpl = path.join(dir, 'video.%(ext)s')
  console.log(`[ig-media] yt-dlp «${bookmark.id}» via ${ytDlp} → ${url}`)
  try {
    const r = await runCmd(
      ytDlp,
      [
        '--no-playlist',
        '-f',
        'mp4/best[ext=mp4]/best',
        '-o',
        outTpl,
        '--newline',
        url,
      ],
      { timeoutMs: 180_000 },
    )
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout || 'sin detalle').trim().slice(-800)
      console.error('[ig-media] yt-dlp failed:', detail)
      return {
        ok: false,
        error: `yt-dlp falló (code ${r.code}): ${detail.slice(0, 240)}`,
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ig-media] yt-dlp error:', msg)
    return { ok: false, error: msg }
  }

  const downloaded = findDownloadedVideo(dir)
  if (!downloaded) {
    return {
      ok: false,
      error: 'yt-dlp terminó OK pero no hay archivo de video en vault',
    }
  }

  const relativePath = path
    .relative(process.cwd(), downloaded)
    .replace(/\\/g, '/')
  persistLocalPath(bookmark.id, relativePath)
  return { ok: true, absPath: downloaded, relativePath }
}

function persistLocalPath(id: string, relativePath: string): void {
  getDb()
    .prepare(`UPDATE bookmarks SET local_media_path = ? WHERE id = ?`)
    .run(relativePath, id)
}

export function resolveLocalMediaAbs(bookmarkId: string): string | null {
  const bm = row<Pick<Bookmark, 'local_media_path'>>(
    getDb()
      .prepare(`SELECT local_media_path FROM bookmarks WHERE id = ?`)
      .get(bookmarkId),
  )
  if (!bm?.local_media_path) return null
  const abs = path.resolve(process.cwd(), bm.local_media_path)
  return fs.existsSync(abs) ? abs : null
}

function ffmpegCandidates(): string[] {
  const home = os.homedir()
  const fromEnv = process.env.FFMPEG_PATH?.replace(/^["']|["']$/g, '').trim()
  return [
    ...(fromEnv ? [fromEnv] : []),
    path.resolve(process.cwd(), 'tools', 'ffmpeg.exe'),
    path.resolve(process.cwd(), 'tools', 'ffmpeg'),
    path.join(home, 'bin', 'ffmpeg.exe'),
    path.join(home, 'bin', 'ffmpeg'),
    'ffmpeg',
    'ffmpeg.exe',
  ]
}

let cachedFfmpeg: string | null = null

/** Resuelve ffmpeg (FFMPEG_PATH → tools/ → %USERPROFILE%\\bin → PATH). */
export async function whichFfmpeg(): Promise<string | null> {
  if (cachedFfmpeg) {
    if (fs.existsSync(cachedFfmpeg)) return cachedFfmpeg
    cachedFfmpeg = null
  }

  const tried: string[] = []
  for (const c of ffmpegCandidates()) {
    const isAbs = path.isAbsolute(c) || /[\\/]/.test(c)
    if (isAbs && !fs.existsSync(c)) {
      tried.push(`${c} (missing)`)
      continue
    }
    try {
      // Verificar con -version: builds shared sin DLLs “existen” pero no arrancan.
      const r = await runCmd(c, ['-version'], {
        timeoutMs: 45_000,
        cwd: isAbs ? path.dirname(c) : undefined,
      })
      if (r.code === 0) {
        cachedFfmpeg = c
        console.log(`[ig-frames] ffmpeg → ${c}`)
        return c
      }
      tried.push(`${c} (exit ${r.code})`)
    } catch (err) {
      tried.push(
        `${c} (${err instanceof Error ? err.message : String(err)})`,
      )
    }
  }
  console.error('[ig-frames] candidatos ffmpeg:', tried.join(' | '))
  return null
}

export async function hasFfmpeg(): Promise<boolean> {
  return Boolean(await whichFfmpeg())
}

/**
 * Extrae fotogramas cada `intervalSec` segundos con ffmpeg.
 * @returns paths absolutos + t_sec
 */
export async function extractFramesEveryNSeconds(
  videoAbsPath: string,
  outDir: string,
  intervalSec = 3,
): Promise<Array<{ t_sec: number; absPath: string }>> {
  fs.mkdirSync(outDir, { recursive: true })
  const ffmpeg = await whichFfmpeg()
  if (!ffmpeg) {
    console.error('[ig-frames] ffmpeg no encontrado en PATH/tools/bin')
    return []
  }
  const pattern = path.join(outDir, 'frame_%04d.jpg')
  try {
    const r = await runCmd(
      ffmpeg,
      [
        '-y',
        '-i',
        videoAbsPath,
        '-vf',
        `fps=1/${Math.max(1, intervalSec)}`,
        '-q:v',
        '4',
        pattern,
      ],
      {
        timeoutMs: 120_000,
        // Builds shared cargan DLL desde el cwd del proceso.
        cwd: path.isAbsolute(ffmpeg) ? path.dirname(ffmpeg) : undefined,
      },
    )
    if (r.code !== 0) {
      console.error('[ig-frames] ffmpeg failed:', r.stderr || r.stdout)
      return []
    }
  } catch (err) {
    console.error('[ig-frames] ffmpeg error:', err)
    return []
  }

  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^frame_\d+\.jpg$/i.test(f))
    .sort()
  return files.map((f, i) => ({
    t_sec: i * intervalSec,
    absPath: path.join(outDir, f),
  }))
}
