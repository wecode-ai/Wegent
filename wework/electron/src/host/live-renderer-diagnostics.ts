import { mkdir, mkdtemp, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Debugger, WebContents } from 'electron'
import { redactLog } from '../runtime/rotating-log.js'
import { profileHotFrames } from './diagnostic-profile-summary.js'

const MAX_EVENTS = 1_000
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'blink.user_timing',
  'v8',
  'disabled-by-default-v8.cpu_profiler',
  'renderer.scheduler',
]

type Target = Pick<
  WebContents,
  'debugger' | 'getOSProcessId' | 'id' | 'isDestroyed' | 'takeHeapSnapshot'
>

export class LiveRendererDiagnostics {
  private active = false

  constructor(
    private readonly target: () => Target | null,
    private readonly root: string
  ) {}

  async dispatch(input: Record<string, unknown>) {
    const action = input.action
    if (action !== 'record' && action !== 'heap') throw new Error('Unknown diagnostics action')
    const durationMs = input.durationMs ?? 10_000
    if (
      !Number.isInteger(durationMs) ||
      Number(durationMs) < 1_000 ||
      Number(durationMs) > 30_000
    ) {
      throw new Error('Recording duration must be between 1000 and 30000 milliseconds')
    }
    if (this.active) throw new Error('A diagnostics collection is already running')
    const target = this.target()
    if (!target || target.isDestroyed()) throw new Error('The current renderer is unavailable')

    this.active = true
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const directory = await mkdtemp(join(this.root, 'renderer-'))
      const pid = target.getOSProcessId()
      if (action === 'heap') {
        const heapPath = join(directory, 'renderer.heapsnapshot')
        await target.takeHeapSnapshot(heapPath)
        return { pid, webContentsId: target.id, heapPath }
      }
      return {
        pid,
        webContentsId: target.id,
        ...(await record(target, directory, Number(durationMs))),
      }
    } finally {
      this.active = false
    }
  }
}

async function record(target: Target, directory: string, durationMs: number) {
  const debug = target.debugger
  if (debug.isAttached()) throw new Error('The renderer already has an attached debugger')
  const events: Record<string, unknown>[] = []
  let dropped = 0
  const tracePath = join(directory, 'renderer.trace.json')
  const profilePath = join(directory, 'renderer.cpuprofile')
  const consolePath = join(directory, 'renderer.console.json')

  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    const entry = consoleEntry(method, params)
    if (!entry) return
    if (events.length < MAX_EVENTS) events.push(entry)
    else dropped += 1
  }

  debug.attach('1.3')
  debug.on('message', onMessage)
  try {
    await debug.sendCommand('Runtime.enable')
    await debug.sendCommand('Profiler.enable')
    await debug.sendCommand('Profiler.start')
    await debug.sendCommand('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: {
        includedCategories: TRACE_CATEGORIES,
        recordMode: 'recordContinuously',
        traceBufferSizeInKb: 32 * 1024,
      },
    })
    await delay(durationMs)
    const { profile } = await debug.sendCommand('Profiler.stop')
    const traceDataLoss = await exportTrace(debug, tracePath)
    await Promise.all([
      writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 }),
      writeFile(consolePath, JSON.stringify({ events, dropped }), { mode: 0o600 }),
    ])
    return {
      profilePath,
      tracePath,
      consolePath,
      traceDataLoss,
      dropped,
      durationMs,
      hotFrames: profileHotFrames(profile),
      recentConsole: events.slice(-3).map(({ timestamp, level, message }) => ({
        timestamp,
        level,
        message: typeof message === 'string' ? message.slice(0, 300) : '',
      })),
    }
  } finally {
    debug.removeListener('message', onMessage)
    if (debug.isAttached()) debug.detach()
  }
}

async function exportTrace(debug: Debugger, path: string) {
  let cleanup = () => {}
  const completion = new Promise<{ stream: string; dataLoss: boolean }>((resolve, reject) => {
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method !== 'Tracing.tracingComplete') return
      if (typeof params.stream !== 'string') {
        reject(new Error('Chromium completed tracing without an export stream'))
        return
      }
      resolve({ stream: params.stream, dataLoss: params.dataLossOccurred === true })
    }
    const onDetach = () => reject(new Error('The renderer detached during trace export'))
    const timeout = setTimeout(() => reject(new Error('Chromium trace export timed out')), 15_000)
    debug.on('message', onMessage)
    debug.once('detach', onDetach)
    cleanup = () => {
      clearTimeout(timeout)
      debug.removeListener('message', onMessage)
      debug.removeListener('detach', onDetach)
    }
  })
  try {
    const [{ stream, dataLoss }] = await Promise.all([completion, debug.sendCommand('Tracing.end')])
    try {
      const file = await open(path, 'wx', 0o600)
      try {
        for (;;) {
          const { data, base64Encoded, eof } = await debug.sendCommand('IO.read', {
            handle: stream,
            size: 1024 * 1024,
          })
          await file.writeFile(data, base64Encoded ? 'base64' : 'utf8')
          if (eof) return dataLoss
        }
      } finally {
        await file.close()
      }
    } finally {
      if (debug.isAttached())
        await debug.sendCommand('IO.close', { handle: stream }).catch(() => {})
    }
  } finally {
    cleanup()
  }
}

function consoleEntry(method: string, params: Record<string, unknown>) {
  if (method === 'Runtime.consoleAPICalled') {
    const args = params.args as { type?: string; value?: unknown }[] | undefined
    const message = (args ?? [])
      .slice(0, 8)
      .map(arg => (typeof arg.value === 'string' ? safeText(arg.value) : arg.type))
      .join(' ')
    return {
      timestamp: params.timestamp,
      level: params.type,
      message,
      stack: callFrames(params.stackTrace),
    }
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails as Record<string, unknown>
    return {
      timestamp: params.timestamp,
      level: 'exception',
      message: safeText(details.text),
      stack: callFrames(details.stackTrace),
    }
  }
  return null
}

function callFrames(stack: unknown) {
  const frames = (stack as { callFrames?: Record<string, unknown>[] })?.callFrames
  return frames?.slice(0, 32).map(frame => ({
    functionName: safeText(frame.functionName),
    lineNumber: frame.lineNumber,
    columnNumber: frame.columnNumber,
    url:
      typeof frame.url === 'string' && URL.canParse(frame.url)
        ? safeText(new URL(frame.url).pathname)
        : '',
  }))
}

function safeText(value: unknown) {
  return typeof value === 'string' ? redactLog(value.slice(0, 1024)) : ''
}
