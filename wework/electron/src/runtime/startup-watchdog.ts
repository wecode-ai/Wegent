import { Worker } from 'node:worker_threads'
import { redactLog } from './rotating-log.js'

// Inspect only stack locations: never capture scopes, arguments or source text.
export const STARTUP_WATCHDOG_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const { appendFileSync } = require('node:fs')
const { Session } = require('node:inspector')
const redact = ${redactLog.toString()}
const heartbeat = new BigInt64Array(workerData.heartbeat)
const write = (event, details) => {
  try {
    appendFileSync(workerData.path, redact(JSON.stringify({
      event, releaseId: workerData.releaseId, ...details,
    })) + '\\n', { mode: 0o600 })
  } catch {}
}
let captured = false
let lastReport = 0
write('startup-watchdog-ready', {})
setInterval(() => {
  const now = Date.now()
  const lastBeat = Atomics.load(heartbeat, 0)
  if (lastBeat === 0n) return
  const ageMs = now - Number(lastBeat)
  if (now - lastReport >= 5000) {
    write('startup-watchdog-heartbeat', { ageMs })
    lastReport = now
  }
  if (captured || ageMs < workerData.stallMs) return
  captured = true
  write('startup-main-thread-stalled', { ageMs })
  const session = new Session()
  try {
    session.connectToMainThread()
    session.once('Debugger.paused', ({ params }) => {
      try {
        write('startup-main-thread-stack', { frames: params.callFrames.slice(0, 24).map(frame => ({
          functionName: frame.functionName.slice(0, 120),
          url: frame.url.split(/[?#]/)[0].slice(0, 300),
          lineNumber: frame.location.lineNumber,
          columnNumber: frame.location.columnNumber,
        })) })
      } finally {
        session.post('Debugger.resume', () => session.disconnect())
      }
    })
    session.post('Debugger.enable', error => {
      if (error) {
        write('startup-stack-unavailable', { errorType: error.name })
        session.disconnect()
      } else session.post('Debugger.pause')
    })
  } catch (error) {
    write('startup-stack-unavailable', { errorType: error.name })
    session.disconnect()
  }
}, workerData.intervalMs)
parentPort.postMessage('ready')
`

export function startStartupWatchdog(path: string, releaseId: string | undefined): () => void {
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8))
  const beat = () => Atomics.store(heartbeat, 0, BigInt(Date.now()))
  beat()
  const worker = new Worker(STARTUP_WATCHDOG_SOURCE, {
    eval: true,
    workerData: {
      heartbeat: heartbeat.buffer,
      path,
      releaseId,
      intervalMs: 1000,
      stallMs: 5000,
    },
  })
  const timer = setInterval(beat, 1000)
  timer.unref()
  worker.on('error', error => {
    clearInterval(timer)
    console.error('[startup-watchdog]', { errorType: error.name })
  })
  worker.unref()
  return () => {
    clearInterval(timer)
    void worker.terminate()
  }
}
