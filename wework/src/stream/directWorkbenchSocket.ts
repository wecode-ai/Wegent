import { io, type Socket } from 'socket.io-client'
import { getToken } from '@/api/auth'
import type { HttpClient } from '@/api/http'
import type { SocketClientSocket } from '@wegent/chat-core'

type SocketHandler = (payload: unknown) => void
type SocketAck = (response?: unknown) => void

const ACTIVE_DEVICE_PROBE_IDLE_MS = 3_000
const INACTIVE_DEVICE_PROBE_IDLE_MS = 30_000
const PROBE_TIMEOUT_MS = 2_000
const CONNECT_TIMEOUT_MS = 20_000
const DIRECT_TICKET_REFRESH_SKEW_MS = 60_000

interface DirectChatEndpoint {
  base_url: string
  socket_path: string
  namespace: string
}

interface DirectChatConnectionResponse {
  connection_id: string
  token: string
  device_id: string
  endpoint: DirectChatEndpoint
  expires_at: string
}

export interface DirectWorkbenchSocket extends SocketClientSocket {
  connectDevice(deviceId: string): Promise<void>
  setActiveDevice(deviceId: string | null): void
  isDeviceConnected(deviceId: string): boolean
}

interface DirectWorkbenchSocketOptions {
  client: HttpClient
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

class DirectWorkbenchSocketImpl implements DirectWorkbenchSocket {
  private readonly client: HttpClient
  private readonly sockets = new Map<string, Socket>()
  private readonly pendingSockets = new Map<string, Promise<Socket>>()
  private readonly handlers = new Map<string, Set<SocketHandler>>()
  private readonly wrappers = new Map<string, Map<string, Map<SocketHandler, SocketHandler>>>()
  private readonly taskDevices = new Map<number, string>()
  private readonly subtaskDevices = new Map<number, string>()
  private readonly staleDevices = new Set<string>()
  private readonly desiredDevices = new Set<string>()
  private readonly directConnections = new Map<string, DirectChatConnectionResponse>()
  private readonly lastActivityAt = new Map<string, number>()
  private readonly probeTimers = new Map<string, ReturnType<typeof window.setTimeout>>()
  private readonly reconnectTimers = new Map<string, ReturnType<typeof window.setTimeout>>()
  private activeDeviceId: string | null = null

  constructor(options: DirectWorkbenchSocketOptions) {
    this.client = options.client
  }

  get connected(): boolean {
    return Boolean(getToken())
  }

  emit<TArgs extends unknown[]>(...args: TArgs): unknown {
    const [event, payload, ack] = args as unknown as [string, unknown, SocketAck | undefined]
    void this.emitAsync(event, payload, ack).catch(error => {
      ack?.({
        success: false,
        error: error instanceof Error ? error.message : '连接未建立，请刷新页面重试',
      })
    })
    return this
  }

  on<TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => void
  ): DirectWorkbenchSocket {
    const socketHandler = handler as unknown as SocketHandler
    const handlers = this.handlers.get(event) ?? new Set<SocketHandler>()
    handlers.add(socketHandler)
    this.handlers.set(event, handlers)

    for (const [deviceId, socket] of this.sockets) {
      this.attachHandler(deviceId, socket, event, socketHandler)
    }
    return this
  }

  off<TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => void
  ): DirectWorkbenchSocket {
    const socketHandler = handler as unknown as SocketHandler
    this.handlers.get(event)?.delete(socketHandler)

    for (const [deviceId, socket] of this.sockets) {
      const wrapped = this.getWrappedHandler(deviceId, event, socketHandler)
      if (wrapped) {
        socket.off(event, wrapped)
      }
    }
    return this
  }

  disconnect(): void {
    for (const timer of this.probeTimers.values()) {
      window.clearTimeout(timer)
    }
    for (const timer of this.reconnectTimers.values()) {
      window.clearTimeout(timer)
    }
    for (const socket of this.sockets.values()) {
      socket.disconnect()
    }
    this.sockets.clear()
    this.pendingSockets.clear()
    this.desiredDevices.clear()
    this.directConnections.clear()
    this.staleDevices.clear()
    this.lastActivityAt.clear()
    this.probeTimers.clear()
    this.reconnectTimers.clear()
  }

  async connectDevice(deviceId: string): Promise<void> {
    this.desiredDevices.add(deviceId)
    try {
      await this.ensureSocket(deviceId)
    } catch (error) {
      this.markDeviceStale(deviceId)
      this.scheduleReconnect(deviceId)
      throw error
    }
  }

  setActiveDevice(deviceId: string | null): void {
    this.activeDeviceId = deviceId
    for (const socketDeviceId of this.sockets.keys()) {
      this.scheduleProbe(socketDeviceId)
    }
    for (const desiredDeviceId of this.desiredDevices) {
      this.scheduleReconnect(desiredDeviceId)
    }
  }

  isDeviceConnected(deviceId: string): boolean {
    return (this.sockets.get(deviceId)?.connected ?? false) && !this.staleDevices.has(deviceId)
  }

  private async emitAsync(event: string, payload?: unknown, ack?: SocketAck): Promise<void> {
    const deviceId = this.resolveDeviceId(payload)
    if (!deviceId) {
      throw new Error('未找到可用设备')
    }

    const socket = await this.ensureSocket(deviceId)
    const enrichedPayload =
      isRecord(payload) && !payload.device_id ? { ...payload, device_id: deviceId } : payload
    this.rememberEventDevice(enrichedPayload, deviceId)
    socket.emit(event, enrichedPayload, (response?: unknown) => {
      this.markDeviceActive(deviceId)
      this.rememberAckDevice(response, deviceId)
      ack?.(response)
    })
  }

  private resolveDeviceId(payload: unknown): string | undefined {
    if (!isRecord(payload)) return undefined
    const directDeviceId = readString(payload.device_id)
    if (directDeviceId) return directDeviceId

    const taskId = typeof payload.task_id === 'number' ? payload.task_id : undefined
    if (taskId && this.taskDevices.has(taskId)) {
      return this.taskDevices.get(taskId)
    }

    const subtaskId = typeof payload.subtask_id === 'number' ? payload.subtask_id : undefined
    if (subtaskId && this.subtaskDevices.has(subtaskId)) {
      return this.subtaskDevices.get(subtaskId)
    }

    return undefined
  }

  private async ensureSocket(deviceId: string): Promise<Socket> {
    const existing = this.sockets.get(deviceId)
    if (existing?.connected) return existing
    if (existing && !this.isConnectionExpiring(deviceId)) {
      return this.waitForSocketConnect(deviceId, existing)
    }
    if (existing) {
      this.disposeSocket(deviceId)
    }

    const pending = this.pendingSockets.get(deviceId)
    if (pending) return pending

    return this.createSocket(deviceId)
  }

  private async createSocket(deviceId: string): Promise<Socket> {
    const connection = await this.getDirectConnection(deviceId)
    const { endpoint } = connection
    const socket = io(`${endpoint.base_url}${endpoint.namespace}`, {
      path: endpoint.socket_path,
      auth: {
        connection_id: connection.connection_id,
        token: connection.token,
      },
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket'],
      timeout: 20000,
    })

    this.sockets.set(deviceId, socket)
    this.attachRegisteredHandlers(deviceId, socket)
    socket.on('connect', () => {
      this.clearReconnect(deviceId)
      this.markDeviceActive(deviceId)
    })
    socket.on('disconnect', () => {
      this.markDeviceStale(deviceId)
      this.scheduleReconnect(deviceId)
    })
    socket.on('connect_error', () => {
      this.markDeviceStale(deviceId)
      this.scheduleReconnect(deviceId)
    })

    return this.waitForSocketConnect(deviceId, socket)
  }

  private async getDirectConnection(deviceId: string): Promise<DirectChatConnectionResponse> {
    const existing = this.directConnections.get(deviceId)
    if (existing && !this.isConnectionExpiring(deviceId)) {
      return existing
    }

    const connection = await this.client.post<DirectChatConnectionResponse>(
      `/local-executor/devices/${encodeURIComponent(deviceId)}/direct-chat/connections`,
      {}
    )
    this.directConnections.set(deviceId, connection)
    return connection
  }

  private waitForSocketConnect(deviceId: string, socket: Socket): Promise<Socket> {
    const pending = this.pendingSockets.get(deviceId)
    if (pending) return pending

    const next = new Promise<Socket>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timer)
        socket.off('connect', handleConnect)
        socket.off('connect_error', handleError)
      }
      const handleConnect = () => {
        cleanup()
        resolve(socket)
      }
      const handleError = (error: Error) => {
        cleanup()
        this.markDeviceStale(deviceId)
        reject(error)
      }
      const timer = window.setTimeout(() => {
        cleanup()
        reject(new Error('连接设备超时'))
      }, CONNECT_TIMEOUT_MS)
      socket.once('connect', handleConnect)
      socket.once('connect_error', handleError)
      if (!socket.connected) {
        socket.connect()
      }
    }).finally(() => {
      this.pendingSockets.delete(deviceId)
    })

    this.pendingSockets.set(deviceId, next)
    return next
  }

  private isConnectionExpiring(deviceId: string): boolean {
    const connection = this.directConnections.get(deviceId)
    if (!connection) return true
    const expiresAt = Date.parse(connection.expires_at)
    if (!Number.isFinite(expiresAt)) return true
    return expiresAt - Date.now() < DIRECT_TICKET_REFRESH_SKEW_MS
  }

  private disposeSocket(deviceId: string): void {
    const socket = this.sockets.get(deviceId)
    if (!socket) return
    socket.removeAllListeners()
    socket.disconnect()
    this.sockets.delete(deviceId)
    this.wrappers.delete(deviceId)
  }

  private scheduleReconnect(deviceId: string): void {
    if (!this.desiredDevices.has(deviceId)) return
    if (this.sockets.get(deviceId)?.connected) return
    this.clearReconnect(deviceId)

    const delay =
      this.activeDeviceId === deviceId ? ACTIVE_DEVICE_PROBE_IDLE_MS : INACTIVE_DEVICE_PROBE_IDLE_MS
    const timer = window.setTimeout(() => {
      void this.ensureSocket(deviceId).catch(() => {
        this.markDeviceStale(deviceId)
        this.scheduleReconnect(deviceId)
      })
    }, delay)
    this.reconnectTimers.set(deviceId, timer)
  }

  private clearReconnect(deviceId: string): void {
    const timer = this.reconnectTimers.get(deviceId)
    if (!timer) return
    window.clearTimeout(timer)
    this.reconnectTimers.delete(deviceId)
  }

  private attachRegisteredHandlers(deviceId: string, socket: Socket): void {
    for (const [event, handlers] of this.handlers) {
      for (const handler of handlers) {
        this.attachHandler(deviceId, socket, event, handler)
      }
    }
  }

  private attachHandler(
    deviceId: string,
    socket: Socket,
    event: string,
    handler: SocketHandler
  ): void {
    const wrapped = (payload: unknown) => {
      this.rememberEventDevice(payload, deviceId)
      this.markDeviceActive(deviceId)
      handler(payload)
    }
    this.setWrappedHandler(deviceId, event, handler, wrapped)
    socket.on(event, wrapped)
  }

  private setWrappedHandler(
    deviceId: string,
    event: string,
    handler: SocketHandler,
    wrapped: SocketHandler
  ): void {
    const deviceWrappers = this.wrappers.get(deviceId) ?? new Map()
    const eventWrappers = deviceWrappers.get(event) ?? new Map()
    const previous = eventWrappers.get(handler)
    if (previous) {
      this.sockets.get(deviceId)?.off(event, previous)
    }
    eventWrappers.set(handler, wrapped)
    deviceWrappers.set(event, eventWrappers)
    this.wrappers.set(deviceId, deviceWrappers)
  }

  private getWrappedHandler(
    deviceId: string,
    event: string,
    handler: SocketHandler
  ): SocketHandler | undefined {
    return this.wrappers.get(deviceId)?.get(event)?.get(handler)
  }

  private emitLocal(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload)
    }
  }

  private rememberEventDevice(payload: unknown, deviceId: string): void {
    if (!isRecord(payload)) return
    const taskId = typeof payload.task_id === 'number' ? payload.task_id : undefined
    const subtaskId = typeof payload.subtask_id === 'number' ? payload.subtask_id : undefined
    if (taskId) this.taskDevices.set(taskId, deviceId)
    if (subtaskId) this.subtaskDevices.set(subtaskId, deviceId)
  }

  private rememberAckDevice(response: unknown, deviceId: string): void {
    if (!isRecord(response)) return
    const taskId = typeof response.task_id === 'number' ? response.task_id : undefined
    const subtaskId = typeof response.subtask_id === 'number' ? response.subtask_id : undefined
    if (taskId) this.taskDevices.set(taskId, deviceId)
    if (subtaskId) this.subtaskDevices.set(subtaskId, deviceId)
  }

  private markDeviceActive(deviceId: string): void {
    const wasStale = this.staleDevices.delete(deviceId)
    const wasKnown = this.lastActivityAt.has(deviceId)
    this.lastActivityAt.set(deviceId, Date.now())
    if (wasStale || !wasKnown) {
      this.emitLocal('device:online', { device_id: deviceId, status: 'online' })
    }
    this.scheduleProbe(deviceId)
  }

  private markDeviceStale(deviceId: string): void {
    const wasStale = this.staleDevices.has(deviceId)
    this.staleDevices.add(deviceId)
    this.clearProbe(deviceId)
    if (!wasStale) {
      this.emitLocal('device:offline', { device_id: deviceId })
    }
    this.scheduleProbe(deviceId)
  }

  private scheduleProbe(deviceId: string): void {
    this.clearProbe(deviceId)
    const socket = this.sockets.get(deviceId)
    if (!socket?.connected) return

    const interval =
      this.activeDeviceId === deviceId ? ACTIVE_DEVICE_PROBE_IDLE_MS : INACTIVE_DEVICE_PROBE_IDLE_MS
    const delay = this.staleDevices.has(deviceId)
      ? interval
      : Math.max(interval - (Date.now() - (this.lastActivityAt.get(deviceId) ?? Date.now())), 0)
    const timer = window.setTimeout(() => {
      void this.probeDevice(deviceId)
    }, delay)
    this.probeTimers.set(deviceId, timer)
  }

  private clearProbe(deviceId: string): void {
    const timer = this.probeTimers.get(deviceId)
    if (timer) {
      window.clearTimeout(timer)
      this.probeTimers.delete(deviceId)
    }
  }

  private async probeDevice(deviceId: string): Promise<void> {
    const socket = this.sockets.get(deviceId)
    if (!socket?.connected) {
      this.markDeviceStale(deviceId)
      return
    }

    const ok = await new Promise<boolean>(resolve => {
      let settled = false
      const settle = (value: boolean) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = window.setTimeout(() => settle(false), PROBE_TIMEOUT_MS)
      socket.emit('connection:probe', (response?: unknown) => {
        window.clearTimeout(timer)
        settle(isRecord(response) && response.success === true)
      })
    })

    if (ok) {
      this.markDeviceActive(deviceId)
    } else {
      this.markDeviceStale(deviceId)
    }
  }
}

export function createDirectWorkbenchSocket(
  options: DirectWorkbenchSocketOptions
): DirectWorkbenchSocket {
  return new DirectWorkbenchSocketImpl(options)
}
