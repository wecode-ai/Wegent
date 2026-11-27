import {
  beginMobileDiagnostic,
  recordMobileDiagnostic,
  mobileSocketLogger,
} from '@/services/mobileDiagnostics'
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
import { decodeRuntimeResult } from './runtimeRpcResult'
import { mobileAbortError, throwIfAborted } from './mobileAbort'
import { isPhoneLocalDeviceId, type LocalRuntime } from './localRuntime'
import type {
  RuntimeDeviceCommandRequest,
  RuntimeDeviceCommandResponse,
} from '@/types/runtimeCommand'

const RUNTIME_NAMESPACE = '/wework-runtime'
const RUNTIME_EVENT = 'runtime:event'
const REQUEST_EVENT = 'runtime:request'
const TRANSCRIPT_TIMEOUT_MS = 15_000
const REQUEST_TIMEOUT_MS = 75_000
export const TRANSCRIPT_PAGE_SIZE = 5
const TRANSCRIPT_PAYLOAD_LIMIT_PAGE_SIZE = 1

type Listener = (event: RuntimeStreamEvent) => void
type LifecycleListener = (address: RuntimeTaskAddress, event: RuntimeStreamEvent) => void

export interface CloudConnectionSnapshot {
  connected: boolean
  error: Error | null
}

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
  private client: AuthenticatedSocketClient | null = null
  private backendIdentity: string | null = null
  private backendRevision = 0
  private readonly pendingRemote = new Set<(cause: Error) => void>()
  private scope: RuntimeTaskAddress | null = null
  private listener: Listener | null = null
  private reconnectListener: (() => void) | null = null
  private lifecycleListener: LifecycleListener | null = null
  private lifecycleReconnectListener: (() => void) | null = null
  private accessToken: string
  private hasConnected = false
  private connectionDiagnostic?: ReturnType<typeof beginMobileDiagnostic>
  private cloudConnection: CloudConnectionSnapshot = { connected: false, error: null }
  private readonly cloudConnectionListeners = new Set<() => void>()
  private scopedEventCount = 0
  private readonly localSubscriptions: (() => void)[] = []

  constructor(
    config: RuntimeSessionConfig | null,
    private readonly getDevices: () => DeviceInfo[] = () => [],
    private readonly local?: LocalRuntime
  ) {
    this.accessToken = config?.accessToken ?? ''
    this.updateBackend(config)
    if (local)
      this.localSubscriptions.push(
        local.onEvent(event => this.onEvent(event, 'local')),
        local.onRecovery(() => {
          if (local.ownsDevice(this.scope?.deviceId)) this.reconnectListener?.()
          this.lifecycleReconnectListener?.()
        })
      )
  }

  isAppDevice(deviceId: string): boolean {
    return this.getDevices().some(
      device =>
        device.device_type === 'app' &&
        (device.execution_target_id === deviceId || device.device_id === deviceId)
    )
  }

  updateBackend(config: RuntimeSessionConfig | null, userId = 0): void {
    const identity = config
      ? `${config.apiBaseUrl}\0${config.socketBaseUrl}\0${config.socketPath}\0${userId}`
      : null
    if (identity === this.backendIdentity) {
      this.updateAccessToken(config?.accessToken ?? '')
      return
    }
    this.backendRevision += 1
    this.connectionDiagnostic?.cancel()
    this.connectionDiagnostic = undefined
    for (const fail of this.pendingRemote) fail(new Error('Wegent 账号已变化，请重新操作'))
    if (this.scope && !this.local?.ownsDevice(this.scope.deviceId)) {
      this.scope = null
      this.listener = null
      this.reconnectListener = null
    }
    this.client?.dispose()
    this.client = null
    this.backendIdentity = identity
    this.hasConnected = false
    this.publishCloudConnection(false, null)
    this.accessToken = config?.accessToken ?? ''
    if (!config) return
    this.connectionDiagnostic = beginMobileDiagnostic('backend-connection', 'cloud')
    const revision = this.backendRevision
    this.client = createSocketClient({
      socketBaseUrl: () => config.socketBaseUrl,
      namespace: RUNTIME_NAMESPACE,
      path: config.socketPath,
      getToken: () => this.accessToken,
      auth: { client_origin: 'wework' },
      logger: mobileSocketLogger,
    })
    this.client.socket.on(RUNTIME_EVENT, envelope => {
      if (revision === this.backendRevision) this.onEvent(envelope)
    })
    this.client.subscribe(state => {
      if (revision !== this.backendRevision) return
      if (!state.isConnected && !state.connectionError && !this.connectionDiagnostic)
        this.connectionDiagnostic = beginMobileDiagnostic('backend-connection', 'cloud')
      if (state.connectionError) {
        this.connectionDiagnostic?.fail(state.connectionError)
        this.connectionDiagnostic = undefined
      } else if (state.isConnected) {
        this.connectionDiagnostic?.complete({ reconnectAttempts: state.reconnectAttempts })
        this.connectionDiagnostic = undefined
      }
      if (state.isConnected) this.hasConnected = true
      this.publishCloudConnection(state.isConnected, state.connectionError)
    })
    this.client.onReconnect(() => {
      if (revision !== this.backendRevision) return
      if (this.scope && !this.local?.ownsDevice(this.scope.deviceId)) this.reconnectListener?.()
      this.lifecycleReconnectListener?.()
    })
    void this.client.connect()
  }

  getCloudConnection = (): CloudConnectionSnapshot => this.cloudConnection

  subscribeCloudConnection = (listener: () => void): (() => void) => {
    this.cloudConnectionListeners.add(listener)
    return () => this.cloudConnectionListeners.delete(listener)
  }

  async reconnectCloud(): Promise<void> {
    await this.requireBackend().ensureConnected()
  }

  private publishCloudConnection(connected: boolean, error: Error | null): void {
    if (connected === this.cloudConnection.connected && error === this.cloudConnection.error) return
    this.cloudConnection = { connected, error }
    this.cloudConnectionListeners.forEach(listener => listener())
  }

  private requireBackend(): AuthenticatedSocketClient {
    if (!this.client) throw new Error('请先登录 Wegent 以使用云设备')
    return this.client
  }

  updateAccessToken(token: string): void {
    if (this.accessToken === token) return
    this.accessToken = token
    if (this.client && !this.client.socket.connected) {
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
    recordMobileDiagnostic('[MobileRuntime] Subscribed', {
      deviceId: scope.deviceId,
      taskId: scope.taskId,
    })
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
      if (!this.local?.ownsDevice(scope.deviceId)) await this.requireBackend().ensureConnected()
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
    const local = this.local?.ownsDevice(deviceId) ?? false
    const diagnostic = beginMobileDiagnostic('work-list', local ? 'phone' : 'cloud')
    try {
      diagnostic.step('request-task-list')
      const response = await this.request<unknown>(
        'runtime.tasks.list',
        {},
        deviceId,
        REQUEST_TIMEOUT_MS
      )
      diagnostic.step('project-task-list')
      const work = adaptRuntimeWorkListResponse(response, deviceId, deviceName)
      diagnostic.complete({ totalTasks: work.totalTasks, projects: work.projects.length })
      return work
    } catch (cause) {
      diagnostic.fail(cause)
      throw cause
    }
  }

  async executeCommand(
    deviceId: string,
    input: RuntimeDeviceCommandRequest,
    signal?: AbortSignal
  ): Promise<RuntimeDeviceCommandResponse> {
    const requested = input.timeout_seconds
    const timeoutSeconds =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.min(Math.ceil(requested), 600)
        : 75
    const startedAt = Date.now()
    const details = { deviceId, commandKey: input.command_key }
    recordMobileDiagnostic('[MobileRuntime] Device command started', details)
    try {
      const result = await this.request<RuntimeDeviceCommandResponse>(
        'device.execute_command',
        { ...input },
        deviceId,
        timeoutSeconds * 1000 + 10_000,
        { signal, relayTimeoutSeconds: timeoutSeconds }
      )
      if (!result || typeof result.success !== 'boolean')
        throw new Error('设备返回了无效的命令响应')
      recordMobileDiagnostic('[MobileRuntime] Device command finished', {
        ...details,
        elapsedMs: Date.now() - startedAt,
        success: result.success,
        exitCode: result.exit_code,
        truncated: result.stdout_truncated === true,
      })
      return result
    } catch (error) {
      recordMobileDiagnostic('[MobileRuntime] Device command failed', {
        ...details,
        elapsedMs: Date.now() - startedAt,
        code: isRecord(error) && typeof error.code === 'string' ? error.code : undefined,
        name: error instanceof Error ? error.name : 'Error',
      })
      throw error
    }
  }

  dispose(): void {
    this.backendRevision += 1
    this.connectionDiagnostic?.cancel()
    this.connectionDiagnostic = undefined
    for (const fail of this.pendingRemote) fail(new Error('运行时连接已关闭'))
    this.scope = null
    this.listener = null
    this.lifecycleListener = null
    this.reconnectListener = null
    this.lifecycleReconnectListener = null
    this.client?.dispose()
    this.localSubscriptions.forEach(unsubscribe => unsubscribe())
  }

  private onEvent(envelope: unknown, source: 'remote' | 'local' = 'remote'): void {
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
    if (
      source === 'remote' &&
      (isPhoneLocalDeviceId(rawDeviceId) ||
        (!rawDeviceId && this.local?.ownsDevice(this.scope?.deviceId)))
    )
      return
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
        recordMobileDiagnostic('[MobileRuntime] Event route', {
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

  async request<T>(
    method: string,
    params: Record<string, unknown>,
    deviceId: string,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    options: { signal?: AbortSignal; relayTimeoutSeconds?: number } = {}
  ): Promise<T> {
    const { signal } = options
    throwIfAborted(signal)
    if (this.local?.ownsDevice(deviceId)) {
      const result = await this.local.request<T>(method, { ...params, deviceId }, timeoutMs)
      throwIfAborted(signal)
      return result
    }
    if (isPhoneLocalDeviceId(deviceId)) throw new Error('当前账号的本机执行环境尚未就绪')
    const client = this.requireBackend()
    const revision = this.backendRevision
    const assertCurrent = () => {
      if (revision !== this.backendRevision) throw new Error('Wegent 账号已变化，请重新操作')
    }
    await client.ensureConnected()
    assertCurrent()
    throwIfAborted(signal)
    const requestId = `mobile-runtime-${nextRequestId++}`
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.pendingRemote.delete(fail)
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        client.socket.off('disconnect', onDisconnect)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = () => fail(mobileAbortError())
      const onDisconnect = () => fail(new Error(`${method} 连接已断开`))
      const timeout = setTimeout(() => {
        fail(new Error(`${method} 请求超时`))
      }, timeoutMs)
      this.pendingRemote.add(fail)
      signal?.addEventListener('abort', onAbort, { once: true })
      client.socket.on('disconnect', onDisconnect)
      if (!client.socket.connected) {
        onDisconnect()
        return
      }

      client.socket.emit(
        REQUEST_EVENT,
        {
          type: 'request',
          id: requestId,
          method,
          params,
          device_id: deviceId,
          timeout_seconds: options.relayTimeoutSeconds ?? Math.ceil(timeoutMs / 1000),
        },
        (ack: RuntimeRequestAck<T> | undefined) => {
          if (settled) return
          if (!ack) {
            fail(new Error(`${method} 返回了空响应`))
            return
          }
          if (ack.ok === false || ack.error) {
            fail(Object.assign(new Error(runtimeRequestError(ack)), { code: ack.error?.code }))
            return
          }
          void decodeRuntimeResult(ack.result).then(result => {
            if (settled) return
            try {
              assertCurrent()
            } catch (cause) {
              fail(cause)
              return
            }
            settled = true
            cleanup()
            resolve(result)
          }, fail)
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
    recordMobileDiagnostic('[MobileTranscript] Transport received', () => ({
      local: this.local?.ownsDevice(address.deviceId) ?? false,
      turns: response.turns?.length,
      messages: response.messages?.length,
      runtimeTurns: response.runtimeTurns?.length,
      before: Boolean(options.beforeCursor),
    }))
    const projected = projectMobileRuntimeTranscript(response)
    recordMobileDiagnostic('[MobileTranscript] Projected', { messages: projected.messages.length })
    return projected
  }
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
