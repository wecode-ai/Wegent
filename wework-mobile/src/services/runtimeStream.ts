import { base64 } from '@scure/base'
import { gunzipSync, strFromU8 } from 'fflate'
import { io, type Socket } from 'socket.io-client'

import type { RuntimeStreamEvent } from '@/domain/chatReducer'
import type { RuntimeTaskAddress, RuntimeTranscriptResponse } from '@/types/runtime'
import type { RuntimeSessionConfig } from './backendConfig'

const RUNTIME_NAMESPACE = '/wework-runtime'
const RUNTIME_EVENT = 'runtime:event'
const REQUEST_EVENT = 'runtime:request'
const TRANSCRIPT_TIMEOUT_MS = 15_000
const TRANSCRIPT_PAGE_SIZE = 50
const COMPRESSED_ENCODING = 'gzip+base64+json'

type Listener = (event: RuntimeStreamEvent) => void
type LifecycleListener = (address: RuntimeTaskAddress, event: RuntimeStreamEvent) => void

interface RuntimeRequestAck<T> {
  ok?: boolean
  result?: T
  error?: {
    code?: string
    message?: string
  }
}

let nextRequestId = 1

export class RuntimeStream {
  private readonly socket: Socket
  private scope: RuntimeTaskAddress | null = null
  private listener: Listener | null = null
  private reconnectListener: (() => void) | null = null
  private lifecycleListener: LifecycleListener | null = null
  private lifecycleReconnectListener: (() => void) | null = null
  private hasConnected = false

  constructor(config: RuntimeSessionConfig) {
    this.socket = io(`${config.socketBaseUrl.replace(/\/+$/, '')}${RUNTIME_NAMESPACE}`, {
      path: config.socketPath,
      auth: { token: config.accessToken, client_origin: 'wework' },
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
    })
    this.socket.on(RUNTIME_EVENT, envelope => this.onEvent(envelope))
    this.socket.on('connect', () => {
      if (this.hasConnected) {
        this.reconnectListener?.()
        this.lifecycleReconnectListener?.()
      }
      this.hasConnected = true
    })
    // Wework connects its runtime listener before task creation so the first
    // response event cannot race the subscription.
    this.socket.connect()
  }

  subscribe(scope: RuntimeTaskAddress, listener: Listener, onReconnect: () => void): () => void {
    this.scope = scope
    this.listener = listener
    this.reconnectListener = onReconnect

    return () => {
      if (this.listener === listener) {
        this.scope = null
        this.listener = null
        this.reconnectListener = null
      }
    }
  }

  subscribeLifecycle(listener: LifecycleListener, onReconnect: () => void): () => void {
    this.lifecycleListener = listener
    this.lifecycleReconnectListener = onReconnect
    return () => {
      if (this.lifecycleListener === listener) {
        this.lifecycleListener = null
        this.lifecycleReconnectListener = null
      }
    }
  }

  getTranscript(address: RuntimeTaskAddress): Promise<RuntimeTranscriptResponse> {
    return this.request(
      'runtime.tasks.transcript',
      { ...address, limit: TRANSCRIPT_PAGE_SIZE },
      address.deviceId,
      TRANSCRIPT_TIMEOUT_MS
    )
  }

  dispose(): void {
    this.socket.removeAllListeners()
    this.socket.disconnect()
  }

  private onEvent(envelope: unknown): void {
    if (!isRecord(envelope)) return
    const name = idValue(envelope.event)
    const payload = envelope.payload
    if (!name || !isRecord(payload)) return
    const data = isRecord(payload.data) ? payload.data : {}
    const taskId = idValue(payload.taskId) ?? idValue(data.taskId)
    const deviceId = idValue(payload.deviceId) ?? idValue(data.deviceId)
    if (!taskId) return
    const event = { name, payload }
    const resolvedDeviceId =
      deviceId ?? (this.scope?.taskId === taskId ? this.scope.deviceId : undefined)
    if (resolvedDeviceId) {
      this.lifecycleListener?.({ deviceId: resolvedDeviceId, taskId }, event)
    }
    if (!this.scope || !this.listener || taskId !== this.scope.taskId) return
    if (deviceId && deviceId !== this.scope.deviceId) return
    this.listener(event)
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
    deviceId: string,
    timeoutMs: number
  ): Promise<T> {
    const requestId = `mobile-runtime-${nextRequestId++}`
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${method} 请求超时`))
      }, timeoutMs)

      this.socket.emit(
        REQUEST_EVENT,
        {
          type: 'request',
          id: requestId,
          method,
          params,
          device_id: deviceId,
          timeout_seconds: Math.ceil(timeoutMs / 1000),
        },
        (ack: RuntimeRequestAck<T> | undefined) => {
          clearTimeout(timeout)
          if (!ack) {
            reject(new Error(`${method} 返回了空响应`))
            return
          }
          if (ack.ok === false || ack.error) {
            reject(new Error(runtimeRequestError(ack)))
            return
          }
          try {
            resolve(decodeRuntimeResult(ack.result))
          } catch (error) {
            reject(error)
          }
        }
      )
    })
  }
}

function decodeRuntimeResult<T>(result: T | undefined): T {
  if (!isCompressedResult(result)) return result as T
  const json = strFromU8(gunzipSync(base64.decode(result.payload)))
  return JSON.parse(json) as T
}

function isCompressedResult(
  result: unknown
): result is { __runtimeRpcEncoding: string; payload: string } {
  return (
    isRecord(result) &&
    result.__runtimeRpcEncoding === COMPRESSED_ENCODING &&
    typeof result.payload === 'string'
  )
}

function runtimeRequestError(ack: RuntimeRequestAck<unknown>): string {
  const code = ack.error?.code?.trim()
  const message = ack.error?.message?.trim() || 'Runtime 请求失败'
  return code ? `${code}: ${message}` : message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
