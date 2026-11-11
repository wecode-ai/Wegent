import type { EventEmitter } from 'node:events'
import { mainProcessLog } from './main-process-log.js'

type ErrorEventSource = Pick<EventEmitter, 'on'>

export function installProcessOutputErrorHandlers(
  stdout: ErrorEventSource = process.stdout,
  stderr: ErrorEventSource = process.stderr
): void {
  stdout.on('error', error => recordOutputStreamError('stdout', error))
  stderr.on('error', error => recordOutputStreamError('stderr', error))
}

function recordOutputStreamError(source: 'stdout' | 'stderr', error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPIPE') return
  // Write directly to the file log: console output would reuse the broken stream.
  void mainProcessLog.write(
    'stderr',
    `[process-output] ${source} unavailable (${code ?? 'unknown'})`
  )
}
