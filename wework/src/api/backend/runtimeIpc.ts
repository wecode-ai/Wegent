import { createSocketClient, type AuthenticatedSocketClient } from '@wegent/chat-core'
import type { LocalExecutorEvent } from '@/tauri/localExecutor'

const WEWORK_RUNTIME_NAMESPACE = '/wework-runtime'
const REQUEST_EVENT = 'runtime:request'
const RUNTIME_EVENT = 'runtime:event'
const ACK_TIMEOUT_MS = 75_000

interface RuntimeIpcClientOptions {
  socketBaseUrl: string
  socketPath: string
  token: string
}

interface RuntimeIpcAck<T> {
  id?: string
  ok?: boolean
  result?: T
  error?: {
    code?: string
    message?: string
  }
}

export interface CloudRuntimeIpcClient {
  request: <T>(method: string, params?: Record<string, unknown>, deviceId?: string) => Promise<T>
  subscribe: (handler: (event: LocalExecutorEvent) => void) => Promise<() => void>
  dispose: () => void
}

let nextRequestId = 1

export function createCloudRuntimeIpcClient(
  options: RuntimeIpcClientOptions
): CloudRuntimeIpcClient {
  const client = createSocketClient({
    socketBaseUrl: () => options.socketBaseUrl,
    path: options.socketPath,
    namespace: WEWORK_RUNTIME_NAMESPACE,
    getToken: () => options.token,
    auth: { client_origin: 'wework' },
    logger: console,
  })

  return {
    request<T>(
      method: string,
      params: Record<string, unknown> = {},
      deviceId?: string
    ): Promise<T> {
      return emitRuntimeRequest<T>(client, method, params, deviceId)
    },
    async subscribe(handler: (event: LocalExecutorEvent) => void): Promise<() => void> {
      await client.ensureConnected()
      const runtimeHandler = (event: LocalExecutorEvent) => {
        handler(event)
      }
      client.socket.on(RUNTIME_EVENT, runtimeHandler)
      return () => client.socket.off(RUNTIME_EVENT, runtimeHandler)
    },
    dispose() {
      client.dispose()
    },
  }
}

async function emitRuntimeRequest<T>(
  client: AuthenticatedSocketClient,
  method: string,
  params: Record<string, unknown>,
  deviceId?: string
): Promise<T> {
  await client.ensureConnected()
  const requestId = `cloud-runtime-${nextRequestId++}`
  const targetDeviceId = deviceId ?? deviceIdFromParams(params)
  if (!targetDeviceId) {
    throw new Error(`Cloud runtime request ${method} missing deviceId`)
  }

  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`${method} timed out`))
    }, ACK_TIMEOUT_MS)

    client.socket.emit(
      REQUEST_EVENT,
      {
        type: 'request',
        id: requestId,
        method,
        params,
        device_id: targetDeviceId,
        timeout_seconds: Math.ceil(ACK_TIMEOUT_MS / 1000),
      },
      (ack: RuntimeIpcAck<T> | undefined) => {
        window.clearTimeout(timeout)
        if (!ack) {
          reject(new Error(`${method} returned an empty acknowledgement`))
          return
        }
        if (ack.ok === false || ack.error) {
          reject(new Error(formatRuntimeIpcError(ack)))
          return
        }
        resolve((ack.result ?? null) as T)
      }
    )
  })
}

function formatRuntimeIpcError(ack: RuntimeIpcAck<unknown>): string {
  const code = ack.error?.code?.trim()
  const message = ack.error?.message?.trim() || 'Cloud runtime request failed'
  return code ? `${code}: ${message}` : message
}

function deviceIdFromParams(params: Record<string, unknown>): string | undefined {
  const direct = stringField(params, 'deviceId') ?? stringField(params, 'device_id')
  if (direct) return direct
  const address = recordField(params, 'address')
  return stringField(address, 'deviceId') ?? stringField(address, 'device_id')
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
