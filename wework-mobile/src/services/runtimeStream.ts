import { base64 } from '@scure/base'
import { gunzipSync, strFromU8 } from 'fflate'
import {
  createSocketClient,
  type AuthenticatedSocketClient,
} from '../../../packages/chat-core/src/socket'
import {
  createWorkbenchDeviceResolver,
  AmbiguousExecutorIdentityError,
} from '../../../packages/chat-core/src/runtime-device-identity'

import type { RuntimeStreamEvent } from '@/domain/chatReducer'
import { adaptRuntimeWorkListResponse } from '@/domain/runtimeWorkAdapter'
import { projectMobileRuntimeTranscript } from '@/domain/runtimeTranscript'
import type { RuntimeTranscriptResponse as CoreTranscript } from '../../../packages/chat-core/src/runtime'
import type {
  RuntimeTaskAddress,
  RuntimeTranscriptResponse,
  RuntimeWorkListResponse,
  DeviceInfo,
} from '@/types/runtime'
import type { RuntimeSessionConfig } from './backendConfig'

const RUNTIME_NAMESPACE = '/wework-runtime'
const RUNTIME_EVENT = 'runtime:event'
const REQUEST_EVENT = 'runtime:request'
const TRANSCRIPT_TIMEOUT_MS = 15_000
const LIST_TIMEOUT_MS = 75_000
export const TRANSCRIPT_PAGE_SIZE = 5
const TRANSCRIPT_PAYLOAD_LIMIT_PAGE_SIZE = 1
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
  private readonly client: AuthenticatedSocketClient
  private scope: RuntimeTaskAddress | null = null
  private listener: Listener | null = null
  private reconnectListener: (() => void) | null = null
  private lifecycleListener: LifecycleListener | null = null
  private lifecycleReconnectListener: (() => void) | null = null
  private accessToken: string
  private hasConnected = false
  private scopedEventCount = 0

  constructor(
    config: RuntimeSessionConfig,
    private readonly getDevices: () => DeviceInfo[] = () => []
  ) {
    this.accessToken = config.accessToken
    this.client = createSocketClient({
      socketBaseUrl: () => config.socketBaseUrl,
      namespace: RUNTIME_NAMESPACE,
      path: config.socketPath,
      getToken: () => this.accessToken,
      auth: { client_origin: 'wework' },
      logger: console,
    })
    this.client.socket.on(RUNTIME_EVENT, envelope => this.onEvent(envelope))
    this.client.subscribe(state => {
      if (state.isConnected) this.hasConnected = true
    })
    this.client.onReconnect(() => {
      this.reconnectListener?.()
      this.lifecycleReconnectListener?.()
    })
    // Wework connects its runtime listener before task creation so the first
    // response event cannot race the subscription.
    void this.client.connect()
  }

  updateAccessToken(token: string): void {
    if (this.accessToken === token) return
    this.accessToken = token
    if (!this.client.socket.connected) {
      this.client.disconnect()
      void this.client.connect(undefined, this.hasConnected)
    }
  }

  async subscribe(
    scope: RuntimeTaskAddress,
    listener: Listener,
    onReconnect: () => void
  ): Promise<() => void> {
    this.scope = scope
    this.scopedEventCount = 0
    console.info('[MobileRuntime] Subscribed', { deviceId: scope.deviceId, taskId: scope.taskId })
    this.listener = listener
    this.reconnectListener = onReconnect

    const unsubscribe = () => {
      if (this.listener === listener) {
        this.scope = null
        this.listener = null
        this.reconnectListener = null
      }
    }
    try {
      await this.client.ensureConnected()
      return unsubscribe
    } catch (error) {
      unsubscribe()
      throw error
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

  async getTranscript(
    address: RuntimeTaskAddress,
    options: { beforeCursor?: string } = {}
  ): Promise<RuntimeTranscriptResponse> {
    try {
      return await this.requestTranscript(address, options, TRANSCRIPT_PAGE_SIZE)
    } catch (error) {
      if (!isTranscriptPayloadLimitError(error)) throw error
      return this.requestTranscript(address, options, TRANSCRIPT_PAYLOAD_LIMIT_PAGE_SIZE)
    }
  }

  async listWork(deviceId: string, deviceName?: string): Promise<RuntimeWorkListResponse> {
    const response = await this.request<unknown>(
      'runtime.tasks.list',
      {},
      deviceId,
      LIST_TIMEOUT_MS
    )
    return adaptRuntimeWorkListResponse(response, deviceId, deviceName)
  }

  dispose(): void {
    this.scope = null
    this.listener = null
    this.lifecycleListener = null
    this.reconnectListener = null
    this.lifecycleReconnectListener = null
    this.client.dispose()
  }

  private onEvent(envelope: unknown): void {
    if (!isRecord(envelope)) return
    const name = idValue(envelope.event)
    const payload = envelope.payload
    if (!name || !isRecord(payload)) return
    const data = isRecord(payload.data) ? payload.data : {}
    const address = isRecord(payload.address) ? payload.address : {}
    const taskId = idValue(payload.taskId) ?? idValue(data.taskId)
    const rawDeviceId =
      idValue(payload.deviceId) ??
      idValue(payload.device_id) ??
      idValue(address.deviceId) ??
      idValue(address.device_id) ??
      idValue(data.deviceId) ??
      idValue(data.device_id)
    let deviceId = rawDeviceId
    const devices = this.getDevices()
    // Backend execution targets are routing addresses, not preferred aliases
    // for a runtime that can have multiple persisted registrations.
    if (rawDeviceId && !devices.some(device => device.execution_target_id === rawDeviceId)) {
      try {
        const device = createWorkbenchDeviceResolver(devices).resolve(rawDeviceId)
        deviceId =
          device?.device_type === 'app'
            ? (device.execution_target_id ?? device.device_id)
            : (device?.device_id ?? rawDeviceId)
      } catch (error) {
        if (error instanceof AmbiguousExecutorIdentityError) return
        throw error
      }
    }
    if (!taskId) return
    if (taskId === this.scope?.taskId) {
      this.scopedEventCount += 1
      if (
        this.scopedEventCount <= 3 ||
        ['response.completed', 'response.failed', 'response.incomplete'].includes(name)
      )
        console.info('[MobileRuntime] Event route', {
          name,
          taskId,
          rawDeviceId,
          deviceId,
          selectedDeviceId: this.scope.deviceId,
          matches: !deviceId || deviceId === this.scope.deviceId,
        })
    }
    const event = {
      name,
      payload:
        deviceId && deviceId !== rawDeviceId
          ? { ...payload, deviceId, device_id: deviceId }
          : payload,
    }
    const resolvedDeviceId =
      deviceId ?? (this.scope?.taskId === taskId ? this.scope.deviceId : undefined)
    if (resolvedDeviceId) {
      this.lifecycleListener?.({ deviceId: resolvedDeviceId, taskId }, event)
    }
    if (!this.scope || !this.listener || taskId !== this.scope.taskId) return
    if (deviceId && deviceId !== this.scope.deviceId) return
    this.listener(event)
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    deviceId: string,
    timeoutMs: number
  ): Promise<T> {
    await this.client.ensureConnected()
    const requestId = `mobile-runtime-${nextRequestId++}`
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`${method} 请求超时`))
      }, timeoutMs)

      this.client.socket.emit(
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

  private async requestTranscript(
    address: RuntimeTaskAddress,
    options: { beforeCursor?: string },
    limit: number
  ): Promise<RuntimeTranscriptResponse> {
    const response = await this.request<CoreTranscript & { taskId: string }>(
      'runtime.tasks.transcript',
      {
        ...address,
        limit,
        ...(options.beforeCursor && { beforeCursor: options.beforeCursor }),
      },
      address.deviceId,
      TRANSCRIPT_TIMEOUT_MS
    )
    return projectMobileRuntimeTranscript(response)
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

function isTranscriptPayloadLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('response exceeded the transport payload limit') ||
    message.includes('runtime_rpc_response_too_large')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function idValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
