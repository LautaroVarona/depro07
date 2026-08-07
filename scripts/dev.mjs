/**
 * Arranca API (Express :3001) + Vite (:5173) juntos.
 * La UI vacía con ECONNREFUSED suele ser Vite solo, sin server.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const bin = (name) =>
  path.join(root, 'node_modules', '.bin', isWin ? `${name}.cmd` : name)

const children = []

function run(label, cmd, args) {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: process.env,
  })
  child.on('exit', (code, signal) => {
    if (signal) return
    if (code && code !== 0) {
      console.error(`[dev] ${label} salió con código ${code}`)
      shutdown(code)
    }
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[dev] API → http://localhost:3001  |  UI → http://localhost:5173')
run('server', bin('tsx'), ['watch', 'server/index.ts'])
run('vite', bin('vite'), [])
