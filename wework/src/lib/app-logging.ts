import { debug, error, info, warn } from '@tauri-apps/plugin-log'

type ConsoleLevel = 'debug' | 'error' | 'info' | 'log' | 'warn'

type TauriWindow = Window &
  typeof globalThis & {
    __TAURI_INTERNALS__?: unknown
  }

const MAX_LOG_ARGUMENT_LENGTH = 4000
const MAX_LOG_MESSAGE_LENGTH = 12000
const VERBOSE_TAURI_LOG_STORAGE_KEY = 'wework:debug-tauri-console-log'

let installed = false

function isTauriRuntime() {
  return typeof window !== 'undefined' && Boolean((window as TauriWindow).__TAURI_INTERNALS__)
}

function shouldWriteTauriLog(level: ConsoleLevel) {
  if (level === 'error' || level === 'warn') {
    return true
  }

  return globalThis.localStorage?.getItem(VERBOSE_TAURI_LOG_STORAGE_KEY) === '1'
}

function serializeLogArgument(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) {
      return serialized
    }
  } catch {
    return String(value)
  }

  return String(value)
}

function truncateLogValue(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
}

function formatLogMessage(args: unknown[]) {
  return truncateLogValue(
    args.map(arg => truncateLogValue(serializeLogArgument(arg), MAX_LOG_ARGUMENT_LENGTH)).join(' '),
    MAX_LOG_MESSAGE_LENGTH
  )
}

function writeTauriLog(level: ConsoleLevel, args: unknown[]) {
  const message = formatLogMessage(args)
  const write =
    level === 'error' ? error : level === 'warn' ? warn : level === 'debug' ? debug : info

  void write(message).catch(() => {
    // Logging must never break the app or recursively write to console.
  })
}

export function installAppLogging() {
  if (installed || !isTauriRuntime()) {
    return
  }

  installed = true

  const originalConsole = {
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  } satisfies Record<ConsoleLevel, (...args: unknown[]) => void>

  ;(['debug', 'error', 'info', 'log', 'warn'] as const).forEach(level => {
    console[level] = (...args: unknown[]) => {
      originalConsole[level](...args)
      if (shouldWriteTauriLog(level)) {
        writeTauriLog(level, args)
      }
    }
  })

  info('Frontend logging initialized')
}
