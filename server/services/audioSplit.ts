/**
 * Parte audios largos (>22 min) en fracciones con ffmpeg.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { whichFfmpeg } from './instagramMedia.js'

export const AUDIO_SEGMENT_MAX_SEC = 22 * 60

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
            reject(
              new Error(`${path.basename(cmd)} timeout ${opts.timeoutMs}ms`),
            )
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

function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = Number(m[3])
  if (![h, min, s].every((n) => Number.isFinite(n))) return null
  return h * 3600 + min * 60 + s
}

export async function probeAudioDurationSec(
  absPath: string,
): Promise<number | null> {
  const ffmpeg = await whichFfmpeg()
  if (!ffmpeg) return null
  try {
    const r = await runCmd(ffmpeg, ['-i', absPath], {
      timeoutMs: 45_000,
      cwd: path.isAbsolute(ffmpeg) ? path.dirname(ffmpeg) : undefined,
    })
    return parseDuration(`${r.stderr}\n${r.stdout}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // ffmpeg -i "falla" con exit ≠ 0; a veces el Duration igual está en el error.
    if (err instanceof Error && 'stderr' in err) {
      /* ignore */
    }
    console.warn('[audio-split] probe:', msg)
    return null
  }
}

export async function splitAudioIfLong(
  absPath: string,
  outDir: string,
  maxSec = AUDIO_SEGMENT_MAX_SEC,
): Promise<{ durationSec: number | null; parts: string[] }> {
  const ffmpeg = await whichFfmpeg()
  const durationSec = await probeAudioDurationSec(absPath)
  if (!ffmpeg) {
    return { durationSec, parts: [] }
  }
  if (durationSec == null || durationSec <= maxSec + 2) {
    return { durationSec, parts: [] }
  }

  fs.mkdirSync(outDir, { recursive: true })
  const ext = path.extname(absPath) || '.m4a'
  const pattern = path.join(outDir, `part_%03d${ext}`)
  const cwd = path.isAbsolute(ffmpeg) ? path.dirname(ffmpeg) : undefined

  const tryCopy = await runCmd(
    ffmpeg,
    [
      '-y',
      '-i',
      absPath,
      '-f',
      'segment',
      '-segment_time',
      String(maxSec),
      '-c',
      'copy',
      '-reset_timestamps',
      '1',
      pattern,
    ],
    { timeoutMs: 180_000, cwd },
  )

  let files = listParts(outDir)
  if (tryCopy.code !== 0 || files.length < 2) {
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(outDir, f))
      } catch {
        /* ignore */
      }
    }
    console.warn(
      '[audio-split] copy segment falló, reencode AAC:',
      tryCopy.stderr.slice(0, 400),
    )
    const aacPattern = path.join(outDir, 'part_%03d.m4a')
    const re = await runCmd(
      ffmpeg,
      [
        '-y',
        '-i',
        absPath,
        '-f',
        'segment',
        '-segment_time',
        String(maxSec),
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-reset_timestamps',
        '1',
        aacPattern,
      ],
      { timeoutMs: 600_000, cwd },
    )
    if (re.code !== 0) {
      console.error('[audio-split] reencode failed:', re.stderr.slice(0, 500))
      return { durationSec, parts: [] }
    }
    files = listParts(outDir)
  }

  const absParts = files.map((f) => path.join(outDir, f))
  console.log(
    `[audio-split] ${path.basename(absPath)} ${durationSec.toFixed(0)}s → ${absParts.length} partes`,
  )
  return { durationSec, parts: absParts }
}

function listParts(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /^part_\d+\./i.test(f))
    .sort()
}
