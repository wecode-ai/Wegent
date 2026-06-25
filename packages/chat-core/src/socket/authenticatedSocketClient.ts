import { io, type Socket } from 'socket.io-client'

type SocketHandler = (...args: never[]) => void

type RawSocket = Omit<Socket, 'emit' | 'on' | 'off' | 'connect' | 'disconnect'> & {
  readonly connected: boolean
  emit: (...args: unknown[]) => unknown
  on: (event: string, handler: SocketHandler) => unknown
  off: (event: string, handler: SocketHandler) => unknown
  connect: () => unknown
  disconnect: () => unknown
}

export interface SocketClientSocket {
  readonly connected: boolean
  emit: <TArgs extends unknown[]>(...args: TArgs) => unknown
  on: <TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => void
  ) => SocketClientSocket
  off: <TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => void
  ) => SocketClientSocket
  disconnect: () => void
}

export interface SocketClientState {
  socket: Socket | null
  isConnected: boolean
  connectionError: Error | null
  reconnectAttempts: number
}

export type SocketClientStateListener = (state: SocketClientState) => void
export type SocketReconnectCallback = () => void

export interface AuthenticatedSocketClientOptions {
  socketBaseUrl: () => string | Promise<string>
  getToken: () => string | null
  namespace?: string
  path?: string
  timeout?: number
  transports?: string[]
  reconnectDelayMs?: (attempt: number) => number
  authErrorEvent?: string
  onAuthError?: (error: unknown) => void
  isAuthError?: (error: Error) => boolean
  auth?: Record<string, unknown>
  logger?: Pick<Console, 'error' | 'info'>
}

export interface AuthenticatedSocketClient {
  readonly socket: SocketClientSocket
  getRawSocket: () => Socket | null
  getState: () => SocketClientState
  subscribe: (listener: SocketClientStateListener) => () => void
  onReconnect: (callback: SocketReconnectCallback) => () => void
  connect: (token?: string, notifyReconnectOnConnect?: boolean) => Promise<void>
  ensureConnected: () => Promise<void>
  disconnect: () => void
  dispose: () => void
}

const DEFAULT_NAMESPACE = '/chat'
const DEFAULT_SOCKET_PATH = '/socket.io'
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_TRANSPORTS = ['websocket']
const RECONNECT_THROTTLE_MS = 500

function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 5000)
}

function defaultIsAuthError(error: Error): boolean {
  const errorMessage = error.message?.toLowerCase() ?? ''
  return (
    errorMessage.includes('expired') ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('jwt') ||
    errorMessage.includes('authentication')
  )
}

function joinNamespace(socketBaseUrl: string, namespace: string): string {
  const normalizedBaseUrl = socketBaseUrl.replace(/\/+$/, '')
  const normalizedNamespace = namespace.startsWith('/') ? namespace : `/${namespace}`
  return `${normalizedBaseUrl}${normalizedNamespace}`
}

class AuthenticatedSocketClientImpl implements AuthenticatedSocketClient {
  private readonly options: Required<
    Pick<
      AuthenticatedSocketClientOptions,
      'namespace' | 'path' | 'timeout' | 'transports' | 'reconnectDelayMs' | 'isAuthError'
    >
  > &
    Omit<
      AuthenticatedSocketClientOptions,
      'namespace' | 'path' | 'timeout' | 'transports' | 'reconnectDelayMs' | 'isAuthError'
    >

  private readonly socketListeners = new Map<string, Set<SocketHandler>>()
  private readonly stateListeners = new Set<SocketClientStateListener>()
  private readonly reconnectCallbacks = new Set<SocketReconnectCallback>()
  private readonly facade: SocketClientSocket

  private rawSocket: RawSocket | null = null
  private connectGeneration = 0
  private isConnecting = false
  private connectRequestPending = false
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  private manualReconnectAttempt = 0
  private intentionalDisconnect = false
  private hasConnectionHistory = false
  private notifyOnNextConnect = false
  private lastReconnectNotificationAt = 0

  private state: SocketClientState = {
    socket: null,
    isConnected: false,
    connectionError: null,
    reconnectAttempts: 0,
  }

  constructor(options: AuthenticatedSocketClientOptions) {
    this.options = {
      namespace: DEFAULT_NAMESPACE,
      path: DEFAULT_SOCKET_PATH,
      timeout: DEFAULT_TIMEOUT_MS,
      transports: DEFAULT_TRANSPORTS,
      reconnectDelayMs: defaultReconnectDelayMs,
      isAuthError: defaultIsAuthError,
      ...options,
    }

    const thisClient = this
    this.facade = {
      get connected() {
        return Boolean(thisClient.rawSocket?.connected)
      },
      emit: <TArgs extends unknown[]>(...args: TArgs) => this.rawSocket?.emit(...args),
      on: <TArgs extends unknown[]>(event: string, handler: (...args: TArgs) => void) => {
        this.addFacadeListener(event, handler as unknown as SocketHandler)
        return this.facade
      },
      off: <TArgs extends unknown[]>(event: string, handler: (...args: TArgs) => void) => {
        this.removeFacadeListener(event, handler as unknown as SocketHandler)
        return this.facade
      },
      disconnect: () => {
        this.disconnect()
      },
    }
  }

  get socket(): SocketClientSocket {
    return this.facade
  }

  getRawSocket(): Socket | null {
    return this.rawSocket as Socket | null
  }

  getState(): SocketClientState {
    return this.state
  }

  subscribe(listener: SocketClientStateListener): () => void {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  onReconnect(callback: SocketReconnectCallback): () => void {
    this.reconnectCallbacks.add(callback)
    return () => {
      this.reconnectCallbacks.delete(callback)
    }
  }

  async connect(token?: string, notifyReconnectOnConnect = false): Promise<void> {
    if (this.rawSocket?.connected || this.isConnecting || this.connectRequestPending) {
      return
    }

    const generationAtStart = this.connectGeneration
    this.clearReconnectTimer()
    this.notifyOnNextConnect = this.notifyOnNextConnect || notifyReconnectOnConnect
    this.connectRequestPending = true

    try {
      const resolvedToken = token ?? this.options.getToken()
      if (!resolvedToken) {
        this.options.logger?.error?.('[Socket.IO] No token found, skipping connection')
        return
      }

      const socketBaseUrl = await this.options.socketBaseUrl()
      if (generationAtStart !== this.connectGeneration) {
        return
      }

      this.connectRequestPending = false
      this.createSocketConnection(resolvedToken, socketBaseUrl)
    } catch (error) {
      if (generationAtStart !== this.connectGeneration) {
        return
      }

      const connectionError = error instanceof Error ? error : new Error(String(error))
      this.options.logger?.error?.('[Socket.IO] Failed to connect:', connectionError)
      this.updateState({
        connectionError,
        isConnected: false,
      })
    } finally {
      this.connectRequestPending = false
    }
  }

  async ensureConnected(): Promise<void> {
    if (this.rawSocket?.connected) {
      return
    }
    await this.connect(undefined, this.hasConnectionHistory)
  }

  disconnect(): void {
    this.connectGeneration += 1
    this.intentionalDisconnect = true
    this.clearReconnectTimer()
    this.isConnecting = false
    this.connectRequestPending = false
    this.manualReconnectAttempt = 0
    this.notifyOnNextConnect = false
    this.hasConnectionHistory = false
    this.disconnectCurrentSocket()
    this.updateState({
      socket: null,
      isConnected: false,
      connectionError: null,
      reconnectAttempts: 0,
    })
  }

  dispose(): void {
    this.disconnect()
    this.stateListeners.clear()
    this.reconnectCallbacks.clear()
    this.socketListeners.clear()
  }

  private createSocketConnection(token: string, socketBaseUrl: string): void {
    this.disconnectCurrentSocket()
    this.intentionalDisconnect = false
    this.isConnecting = true

    const socket = io(joinNamespace(socketBaseUrl, this.options.namespace), {
      path: this.options.path,
      auth: { ...this.options.auth, token },
      autoConnect: false,
      reconnection: false,
      transports: this.options.transports,
      timeout: this.options.timeout,
      forceNew: true,
      multiplex: false,
    }) as unknown as RawSocket

    this.rawSocket = socket
    this.bindInternalSocketHandlers(socket)
    this.bindFacadeListeners(socket)
    this.updateState({
      socket: socket as Socket,
      isConnected: false,
      connectionError: null,
    })
    socket.connect()
  }

  private bindInternalSocketHandlers(socket: RawSocket): void {
    socket.on('connect', () => {
      if (this.rawSocket !== socket) {
        return
      }

      const shouldNotifyReconnect = this.hasConnectionHistory || this.notifyOnNextConnect
      this.hasConnectionHistory = true
      this.notifyOnNextConnect = false
      this.manualReconnectAttempt = 0
      this.isConnecting = false
      this.clearReconnectTimer()
      this.updateState({
        isConnected: true,
        connectionError: null,
        reconnectAttempts: 0,
      })

      if (shouldNotifyReconnect) {
        this.notifyReconnectSubscribers()
      }
    })

    socket.on('disconnect', (reason: string) => {
      if (this.rawSocket !== socket) {
        return
      }

      this.hasConnectionHistory = true
      this.isConnecting = false
      this.updateState({
        isConnected: false,
      })

      if (this.shouldReconnect(reason)) {
        this.queueReconnect(reason)
      }
    })

    socket.on('connect_error', (error: Error) => {
      if (this.rawSocket !== socket) {
        return
      }

      this.options.logger?.error?.('[Socket.IO] Connection error:', error)
      this.isConnecting = false
      this.updateState({
        connectionError: error,
        isConnected: false,
      })

      if (this.options.isAuthError(error)) {
        this.intentionalDisconnect = true
        this.options.onAuthError?.(error)
        return
      }

      if (this.shouldReconnect(error.message || 'connect_error')) {
        this.queueReconnect(error.message || 'connect_error')
      }
    })

    if (this.options.authErrorEvent) {
      socket.on(this.options.authErrorEvent, error => {
        if (this.rawSocket !== socket) {
          return
        }

        this.intentionalDisconnect = true
        this.options.onAuthError?.(error)
        socket.disconnect()
        this.updateState({
          isConnected: false,
        })
      })
    }
  }

  private addFacadeListener<TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => void
  ): void {
    const socketHandler = handler as unknown as SocketHandler
    const eventHandlers = this.socketListeners.get(event) ?? new Set<SocketHandler>()
    eventHandlers.add(socketHandler)
    this.socketListeners.set(event, eventHandlers)
    this.rawSocket?.on(event, socketHandler)
  }

  private removeFacadeListener<TArgs extends unknown[]>(
    event: string,
    handler: (...args: TArgs) => void
  ): void {
    const socketHandler = handler as unknown as SocketHandler
    this.socketListeners.get(event)?.delete(socketHandler)
    this.rawSocket?.off(event, socketHandler)
  }

  private bindFacadeListeners(socket: RawSocket): void {
    this.socketListeners.forEach((handlers, event) => {
      handlers.forEach(handler => {
        socket.on(event, handler)
      })
    })
  }

  private disconnectCurrentSocket(): void {
    const currentSocket = this.rawSocket
    if (!currentSocket) {
      return
    }

    this.rawSocket = null
    currentSocket.disconnect()
  }

  private shouldReconnect(reason: string): boolean {
    if (this.intentionalDisconnect) {
      return false
    }
    if (reason === 'io client disconnect' || reason === 'client namespace disconnect') {
      return false
    }
    return Boolean(this.options.getToken())
  }

  private queueReconnect(reason: string): void {
    if (
      this.intentionalDisconnect ||
      this.rawSocket?.connected ||
      this.isConnecting ||
      this.connectRequestPending ||
      this.reconnectTimer !== null
    ) {
      return
    }

    if (!this.options.getToken()) {
      return
    }

    const attempt = this.manualReconnectAttempt + 1
    this.manualReconnectAttempt = attempt
    this.updateState({
      reconnectAttempts: attempt,
    })

    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null
      if (this.connectRequestPending || this.isConnecting) {
        this.queueReconnect(reason)
        return
      }

      this.options.logger?.info?.(
        '[Socket.IO] Reconnecting with a fresh authenticated namespace socket',
        {
          reason,
          attempt,
        }
      )
      void this.connect(undefined, true)
    }, this.options.reconnectDelayMs(attempt))
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) {
      return
    }
    globalThis.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private notifyReconnectSubscribers(): void {
    const now = Date.now()
    if (now - this.lastReconnectNotificationAt < RECONNECT_THROTTLE_MS) {
      return
    }
    this.lastReconnectNotificationAt = now

    this.reconnectCallbacks.forEach(callback => {
      try {
        callback()
      } catch (error) {
        this.options.logger?.error?.('[Socket.IO] Error in reconnect callback:', error)
      }
    })
  }

  private updateState(nextState: Partial<SocketClientState>): void {
    this.state = {
      ...this.state,
      ...nextState,
    }
    this.stateListeners.forEach(listener => {
      listener(this.state)
    })
  }
}

export function createAuthenticatedSocketClient(
  options: AuthenticatedSocketClientOptions
): AuthenticatedSocketClient {
  return new AuthenticatedSocketClientImpl(options)
}

export const createSocketClient = createAuthenticatedSocketClient
