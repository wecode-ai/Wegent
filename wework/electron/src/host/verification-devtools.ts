import type { WebContents } from 'electron'
import { acquireDebuggerSession, type DebuggerLease } from './debugger-session.js'

const MAX_EVENT_BYTES = 32 * 1024 * 1024
const MAX_EVENTS = 20_000

type Target = Pick<
  WebContents,
  'id' | 'debugger' | 'isDestroyed' | 'getURL' | 'getTitle' | 'getType'
>
interface ProtocolEvent {
  sequence: number
  timestamp: number
  method: string
  params: unknown
  sessionId?: string
}
interface Connection {
  target: Target
  lease: DebuggerLease
  events: Array<{ event: ProtocolEvent; bytes: number }>
  bytes: number
  sequence: number
  discardedThrough: number
  onMessage: (event: unknown, method: string, params: unknown, sessionId?: string) => void
  onDetach: (event: unknown, reason: string) => void
}

/** Full CDP access, available only on the isolated verification host's authenticated bridge. */
export class VerificationDevtools {
  private readonly connections = new Map<number, Connection>()

  constructor(private readonly targets: () => Target[]) {}

  async dispatch(input: Record<string, unknown>): Promise<unknown> {
    if (input.action === 'targets') {
      return this.targets()
        .filter(target => !target.isDestroyed())
        .map(target => ({
          id: target.id,
          type: target.getType(),
          title: target.getTitle(),
          url: target.getURL(),
          attached: this.connections.get(target.id)?.lease.isActive() ?? false,
        }))
    }
    const id = input.target
    if (!Number.isInteger(id)) throw new Error('DevTools target must be a webContents id')
    if (input.action === 'detach') {
      this.disconnect(id as number)
      return { detached: true }
    }
    const connection =
      input.action === 'events'
        ? (this.connections.get(id as number) ?? this.connect(id as number))
        : this.connect(id as number)
    if (input.action === 'events') return this.readEvents(connection, input)
    if (input.action !== 'command') throw new Error('Unknown DevTools action')
    if (typeof input.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(input.method)) {
      throw new Error('DevTools method must be Domain.command')
    }
    if (
      input.params !== undefined &&
      (!input.params || typeof input.params !== 'object' || Array.isArray(input.params))
    ) {
      throw new Error('DevTools params must be an object')
    }
    if (input.sessionId !== undefined && typeof input.sessionId !== 'string') {
      throw new Error('DevTools sessionId must be a string')
    }
    return connection.target.debugger.sendCommand(input.method, input.params, input.sessionId)
  }

  close(): void {
    for (const id of this.connections.keys()) this.disconnect(id)
  }

  private connect(id: number): Connection {
    const existing = this.connections.get(id)
    if (existing) {
      if (!existing.lease.isActive())
        throw new Error('DevTools detached; read events, then detach before reconnecting')
      return existing
    }
    const target = this.targets().find(target => target.id === id && !target.isDestroyed())
    if (!target) throw new Error(`Unknown DevTools target: ${id}`)
    const connection: Connection = {
      target,
      lease: acquireDebuggerSession(target),
      events: [],
      bytes: 0,
      sequence: 0,
      discardedThrough: 0,
      onMessage: (_event, method, params, sessionId) =>
        this.append(connection, method, params, sessionId),
      onDetach: (_event, reason) => this.append(connection, 'Inspector.detached', { reason }),
    }
    target.debugger.on('message', connection.onMessage)
    target.debugger.on('detach', connection.onDetach)
    this.connections.set(id, connection)
    return connection
  }

  private append(
    connection: Connection,
    method: string,
    params: unknown,
    sessionId?: string
  ): void {
    const event = {
      sequence: ++connection.sequence,
      timestamp: Date.now(),
      method,
      params,
      sessionId,
    }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    connection.events.push({ event, bytes })
    connection.bytes += bytes
    while (connection.bytes > MAX_EVENT_BYTES || connection.events.length > MAX_EVENTS) {
      const removed = connection.events.shift()!
      connection.bytes -= removed.bytes
      connection.discardedThrough = removed.event.sequence
    }
  }

  private readEvents(connection: Connection, input: Record<string, unknown>) {
    const after = input.after ?? 0
    const limit = input.limit ?? 1000
    if (
      !Number.isSafeInteger(after) ||
      (after as number) < 0 ||
      !Number.isSafeInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 1000
    ) {
      throw new Error('DevTools events require after >= 0 and limit between 1 and 1000')
    }
    const events = connection.events
      .filter(({ event }) => event.sequence > (after as number))
      .slice(0, limit as number)
      .map(({ event }) => event)
    return {
      events,
      next: events.at(-1)?.sequence ?? Math.max(after as number, connection.discardedThrough),
      latest: connection.sequence,
      lost: Math.max(0, connection.discardedThrough - (after as number)),
      attached: connection.lease.isActive(),
    }
  }

  private disconnect(id: number): void {
    const connection = this.connections.get(id)
    if (!connection) return
    connection.target.debugger.off('message', connection.onMessage)
    connection.target.debugger.off('detach', connection.onDetach)
    connection.lease.release()
    this.connections.delete(id)
  }
}
