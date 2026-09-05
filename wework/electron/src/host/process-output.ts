import type { EventEmitter } from 'node:events'

type ErrorEventSource = Pick<EventEmitter, 'on'>

export function installProcessOutputErrorHandlers(
  stdout: ErrorEventSource = process.stdout,
  stderr: ErrorEventSource = process.stderr
): void {
  stdout.on('error', preserveOutputStreamErrors)
  stderr.on('error', preserveOutputStreamErrors)
}

function preserveOutputStreamErrors(error: unknown): void {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') return
  throw error
}
