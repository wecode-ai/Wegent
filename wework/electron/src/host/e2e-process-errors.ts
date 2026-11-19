import type { ChildProcess } from 'node:child_process'
import { errorMonitor, type EventEmitter } from 'node:events'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import type { Worker } from 'node:worker_threads'
import { StringDecoder } from 'node:string_decoder'
import { e2eErrorLog } from './e2e-error-log.js'

let installed = false

/** Observe native lifecycle events without replacing spawn or consuming pipes. */
export function observeE2EChildProcess(child: ChildProcess): void {
  const events: EventEmitter = child
  child.once('spawn', () => {
    e2eErrorLog.record('process', 'spawned', 'info', { childPid: child.pid })
  })
  events.once(errorMonitor, (error: Error) => {
    e2eErrorLog.record('process', 'spawn-failed', 'error', {
      childPid: child.pid,
      message: error.message,
      stack: error.stack,
    })
  })
  child.once('close', (code, signal) => {
    e2eErrorLog.record('process', 'closed', code === 0 && signal === null ? 'info' : 'error', {
      childPid: child.pid,
      code,
      signal,
    })
  })
}

export function observeE2EWorker(worker: Worker): void {
  const threadId = worker.threadId
  e2eErrorLog.record('worker', 'started', 'info', { threadId })
  observeWorkerOutput(worker)
  worker.on(errorMonitor, error => {
    e2eErrorLog.record('worker', 'uncaught-exception', 'error', {
      threadId,
      message: error.message,
      stack: error.stack,
    })
  })
  worker.once('exit', code => {
    e2eErrorLog.record('worker', 'exited', code === 0 ? 'info' : 'error', { threadId, code })
  })
}

function observeWorkerOutput(worker: Worker): void {
  const threadId = worker.threadId
  for (const [type, stream] of [
    ['stdout', worker.stdout],
    ['stderr', worker.stderr],
  ] as const) {
    if (stream.readableFlowing !== true) {
      e2eErrorLog.record('worker', 'output-not-observed', 'error', { threadId, stream: type })
      continue
    }
    const decoder = new StringDecoder('utf8')
    const record = (message: string) => {
      if (message)
        e2eErrorLog.record('worker', type, type === 'stderr' ? 'error' : 'info', {
          threadId,
          message,
        })
    }
    stream.on('data', (chunk: Buffer | string) =>
      record(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    )
    stream.once('end', () => record(decoder.end()))
  }
}

export function installE2EProcessErrors(): () => void {
  if (installed || process.env.VITE_WEWORK_E2E !== 'true') return () => undefined
  installed = true
  const onChildProcess = (message: unknown) => {
    observeE2EChildProcess((message as { process: ChildProcess }).process)
  }
  subscribe('child_process', onChildProcess)
  process.on('worker', observeE2EWorker)
  e2eErrorLog.record('process', 'collector-started', 'info', {})
  e2eErrorLog.record('worker', 'collector-started', 'info', {})
  return () => {
    unsubscribe('child_process', onChildProcess)
    process.off('worker', observeE2EWorker)
    installed = false
  }
}
