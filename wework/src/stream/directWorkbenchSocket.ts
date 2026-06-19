import { io, type Socket } from 'socket.io-client'
import { getToken } from '@/api/auth'
import type { HttpClient } from '@/api/http'
import type { SocketClientSocket } from '@wegent/chat-core'

type SocketHandler = (payload: unknown) => void
type SocketAck = (response?: unknown) => void

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
}

export interface DirectWorkbenchSocket extends SocketClientSocket {
  connectDevice(deviceId: string): Promise<void>
  isDeviceConnected(deviceId: string): boolean
}

interface DirectWorkbenchSocketOptions {
  backendSocket: SocketClientSocket
  client: HttpClient
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

class DirectWorkbenchSocketImpl implements DirectWorkbenchSocket {
  private readonly backendSocket: SocketClientSocket
  private readonly client: HttpClient
  private readonly sockets = new Map<string, Socket>()
  private readonly pendingSockets = new Map<string, Promise<Socket>>()
  private readonly handlers = new Map<string, Set<SocketHandler>>()
  private readonly wrappers = new Map<string, Map<string, Map<SocketHandler, SocketHandler>>>()
  private readonly taskDevices = new Map<number, string>()
  private readonly subtaskDevices = new Map<number, string>()

  constructor(options: DirectWorkbenchSocketOptions) {
    this.backendSocket = options.backendSocket
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

    if (this.isBackendEvent(event)) {
      this.backendSocket.on(event, handler)
    }
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

    if (this.isBackendEvent(event)) {
      this.backendSocket.off(event, handler)
    }
    for (const [deviceId, socket] of this.sockets) {
      const wrapped = this.getWrappedHandler(deviceId, event, socketHandler)
      if (wrapped) {
        socket.off(event, wrapped)
      }
    }
    return this
  }

  disconnect(): void {
    this.backendSocket.disconnect()
    for (const socket of this.sockets.values()) {
      socket.disconnect()
    }
    this.sockets.clear()
    this.pendingSockets.clear()
  }

  async connectDevice(deviceId: string): Promise<void> {
    await this.ensureSocket(deviceId)
  }

  isDeviceConnected(deviceId: string): boolean {
    return this.sockets.get(deviceId)?.connected ?? false
  }

  private async emitAsync(event: string, payload?: unknown, ack?: SocketAck): Promise<void> {
    const deviceId = this.resolveDeviceId(payload)
    if (!deviceId) {
      if (event === 'task:join' || event === 'task:leave') {
        this.backendSocket.emit(event, payload, ack)
        return
      }
      throw new Error('未找到可用设备')
    }

    const socket = await this.ensureSocket(deviceId)
    const enrichedPayload =
      isRecord(payload) && !payload.device_id ? { ...payload, device_id: deviceId } : payload
    this.rememberEventDevice(enrichedPayload, deviceId)
    socket.emit(event, enrichedPayload, (response?: unknown) => {
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

    const pending = this.pendingSockets.get(deviceId)
    if (pending) return pending

    const next = this.createSocket(deviceId).finally(() => {
      this.pendingSockets.delete(deviceId)
    })
    this.pendingSockets.set(deviceId, next)
    return next
  }

  private async createSocket(deviceId: string): Promise<Socket> {
    const connection = await this.client.post<DirectChatConnectionResponse>(
      `/local-executor/devices/${encodeURIComponent(deviceId)}/direct-chat/connections`,
      {}
    )
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
      this.emitLocal('device:online', { device_id: deviceId, status: 'online' })
    })
    socket.on('disconnect', () => {
      this.emitLocal('device:offline', { device_id: deviceId })
    })

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off('connect', handleConnect)
        socket.off('connect_error', handleError)
      }
      const handleConnect = () => {
        cleanup()
        resolve()
      }
      const handleError = (error: Error) => {
        cleanup()
        socket.disconnect()
        this.sockets.delete(deviceId)
        reject(error)
      }
      socket.once('connect', handleConnect)
      socket.once('connect_error', handleError)
      socket.connect()
    })

    return socket
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

  private isBackendEvent(event: string): boolean {
    return (
      event === 'device:online' ||
      event === 'device:offline' ||
      event === 'device:status' ||
      event === 'device:slot_update' ||
      event === 'device:upgrade_status'
    )
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
}

export function createDirectWorkbenchSocket(
  options: DirectWorkbenchSocketOptions
): DirectWorkbenchSocket {
  return new DirectWorkbenchSocketImpl(options)
}
