import { randomBytes } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import {
  HOST_PROTOCOL_VERSION,
  HostCapabilityError,
  type HostCapabilityCompletion,
  type HostCapabilityRouter,
} from './capability-router.js'

const REQUEST_FD = 3
const RESPONSE_FD = 4
const MAX_FRAME_BYTES = 1024 * 1024

interface HostPipeSession {
  input: Readable
  output: Writable
  lines: Interface
  principal: string | null
}

export interface HostPipeEvents {
  ready: [string]
  close: []
  protocolError: [Error]
}

export class HostPipeServer extends EventEmitter<HostPipeEvents> {
  private readonly token = randomBytes(32).toString('base64url')
  private session: HostPipeSession | null = null

  constructor(private readonly router: HostCapabilityRouter) {
    super()
  }

  environment(): NodeJS.ProcessEnv {
    return {
      WEWORK_ELECTRON_HOST_PROTOCOL: String(HOST_PROTOCOL_VERSION),
      WEWORK_ELECTRON_HOST_TOKEN: this.token,
      WEWORK_ELECTRON_HOST_REQUEST_FD: String(REQUEST_FD),
      WEWORK_ELECTRON_HOST_RESPONSE_FD: String(RESPONSE_FD),
    }
  }

  attach(child: ChildProcessWithoutNullStreams): void {
    const output = child.stdio[REQUEST_FD]
    const input = child.stdio[RESPONSE_FD]
    if (!output || typeof (output as Writable).write !== 'function') {
      throw new Error('DSH host request pipe is unavailable')
    }
    if (!input || typeof (input as Readable).pipe !== 'function') {
      throw new Error('DSH host response pipe is unavailable')
    }
    this.attachStreams(input as Readable, output as Writable)
  }

  attachStreams(input: Readable, output: Writable): void {
    this.detach()
    const lines = createInterface({ input })
    const session: HostPipeSession = {
      input,
      output,
      lines,
      principal: null,
    }
    this.session = session
    lines.on('line', line => void this.handleLine(session, line))
    input.once('close', () => {
      if (this.session !== session) return
      this.detach()
      this.emit('close')
    })
  }

  stop(): void {
    this.detach()
  }

  private async handleLine(session: HostPipeSession, rawLine: string): Promise<void> {
    if (Buffer.byteLength(rawLine) > MAX_FRAME_BYTES) {
      this.protocolFailure(session, new Error('Desktop host frame exceeds size limit'))
      return
    }
    let message: unknown
    try {
      message = JSON.parse(rawLine)
    } catch {
      this.protocolFailure(session, new Error('Desktop host frame is not valid JSON'))
      return
    }
    if (!isRecord(message)) {
      this.protocolFailure(session, new Error('Desktop host frame must be an object'))
      return
    }
    if (!session.principal) {
      this.handleHello(session, message)
      return
    }
    if (
      message.type !== 'request' ||
      typeof message.id !== 'string' ||
      typeof message.capability !== 'string' ||
      !isRecord(message.params)
    ) {
      this.protocolFailure(session, new Error('Desktop host request is malformed'))
      return
    }
    try {
      const completions: HostCapabilityCompletion[] = []
      const result = await this.router.invoke(
        session.principal,
        message.capability,
        message.params,
        {
          onResponseSent: completion => completions.push(completion),
        }
      )
      this.write(
        session,
        {
          type: 'response',
          id: message.id,
          ok: true,
          result: result ?? null,
        },
        () => this.runCompletions(completions)
      )
    } catch (error) {
      const normalized =
        error instanceof HostCapabilityError
          ? error
          : new HostCapabilityError(
              'capability_failed',
              error instanceof Error ? error.message : String(error)
            )
      this.write(session, {
        type: 'response',
        id: message.id,
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          details: normalized.details,
        },
      })
    }
  }

  private handleHello(session: HostPipeSession, message: Record<string, unknown>): void {
    const principal = typeof message.principal === 'string' ? message.principal.trim() : ''
    if (
      message.type !== 'hello' ||
      message.protocolVersion !== HOST_PROTOCOL_VERSION ||
      message.token !== this.token ||
      !principal
    ) {
      this.protocolFailure(session, new Error('Desktop host handshake was rejected'))
      return
    }
    session.principal = principal
    this.write(session, {
      type: 'hello',
      ok: true,
      protocolVersion: HOST_PROTOCOL_VERSION,
      capabilities: this.router.describe(principal),
    })
    this.emit('ready', principal)
  }

  private write(session: HostPipeSession, message: unknown, onWritten?: () => void): void {
    session.output.write(`${JSON.stringify(message)}\n`, error => {
      if (error) {
        this.protocolFailure(session, error)
        return
      }
      onWritten?.()
    })
  }

  private runCompletions(completions: HostCapabilityCompletion[]): void {
    void (async () => {
      for (const completion of completions) await completion()
    })().catch(error => {
      console.error('[host-pipe] post-response completion failed', error)
    })
  }

  private protocolFailure(session: HostPipeSession, error: Error): void {
    this.emit('protocolError', error)
    if (this.session === session) this.detach()
  }

  private detach(): void {
    const session = this.session
    this.session = null
    if (!session) return
    session.lines.close()
    session.input.removeAllListeners('close')
    if (!session.output.destroyed) session.output.end()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
