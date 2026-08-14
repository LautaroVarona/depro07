export type ClientLogLine = {
  t: string
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  message: string
}

const MAX_LINES = 80
const buffer: ClientLogLine[] = []

function stringifyArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
    .slice(0, 2500)
}

function push(level: ClientLogLine['level'], args: unknown[]): void {
  buffer.push({
    t: new Date().toISOString(),
    level,
    message: stringifyArgs(args),
  })
  if (buffer.length > MAX_LINES) {
    buffer.splice(0, buffer.length - MAX_LINES)
  }
}

export function installClientLogBuffer(): void {
  const w = window as Window & { __deprocastLogsInstalled?: boolean }
  if (w.__deprocastLogsInstalled) return
  w.__deprocastLogsInstalled = true

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  }

  console.log = (...args: unknown[]) => {
    push('log', args)
    orig.log(...args)
  }
  console.info = (...args: unknown[]) => {
    push('info', args)
    orig.info(...args)
  }
  console.warn = (...args: unknown[]) => {
    push('warn', args)
    orig.warn(...args)
  }
  console.error = (...args: unknown[]) => {
    push('error', args)
    orig.error(...args)
  }
  console.debug = (...args: unknown[]) => {
    push('debug', args)
    orig.debug(...args)
  }

  window.addEventListener('error', (ev) => {
    push('error', [
      `window.error ${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}`,
    ])
  })
  window.addEventListener('unhandledrejection', (ev) => {
    push('error', [`unhandledrejection ${String(ev.reason)}`])
  })
}

export function getClientLogs(): ClientLogLine[] {
  return buffer.slice()
}
