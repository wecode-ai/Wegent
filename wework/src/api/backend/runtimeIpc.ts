import { createSocketClient, type AuthenticatedSocketClient } from '@wegent/chat-core'
import type { LocalExecutorEvent } from '@/desktop/localExecutor'

const WEWORK_RUNTIME_NAMESPACE = '/wework-runtime'
const REQUEST_EVENT = 'runtime:request'
const RUNTIME_EVENT = 'runtime:event'
const ACK_TIMEOUT_MS = 75_000
export const RUNTIME_TRANSCRIPT_ACK_TIMEOUT_MS = 15_000
const RUNTIME_RPC_COMPRESSED_ENCODING = 'gzip+base64+json'
const COMMAND_ACK_GRACE_MS = 10_000
const MAX_COMMAND_TIMEOUT_SECONDS = 600

interface DecompressionStreamConstructor {
  new (format: string): TransformStream<Uint8Array, Uint8Array>
}

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
  request: <T>(
    method: string,
    params?: Record<string, unknown>,
    deviceId?: string,
    timeoutMs?: number
  ) => Promise<T>
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
      deviceId?: string,
      timeoutMs = ACK_TIMEOUT_MS
    ): Promise<T> {
      return emitRuntimeRequest<T>(client, method, params, deviceId, timeoutMs)
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
  deviceId?: string,
  timeoutMs = ACK_TIMEOUT_MS
): Promise<T> {
  await client.ensureConnected()
  const requestId = `cloud-runtime-${nextRequestId++}`
  const targetDeviceId = deviceId ?? deviceIdFromParams(params)
  if (!targetDeviceId) {
    throw new Error(`Cloud runtime request ${method} missing deviceId`)
  }
  const relayTimeoutSeconds = resolveRelayTimeoutSeconds(method, params, timeoutMs)
  const acknowledgementTimeoutMs =
    method === 'device.execute_command'
      ? relayTimeoutSeconds * 1000 + COMMAND_ACK_GRACE_MS
      : timeoutMs

  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(`${method} timed out`))
    }, acknowledgementTimeoutMs)

    client.socket.emit(
      REQUEST_EVENT,
      {
        type: 'request',
        id: requestId,
        method,
        params,
        device_id: targetDeviceId,
        timeout_seconds: relayTimeoutSeconds,
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
        void decodeRuntimeIpcResult<T>(ack.result ?? null).then(resolve, reject)
      }
    )
  })
}

async function decodeRuntimeIpcResult<T>(result: unknown): Promise<T> {
  if (!isCompressedRuntimeIpcResult(result)) {
    return result as T
  }

  const DecompressionStreamCtor = (
    globalThis as unknown as {
      DecompressionStream?: DecompressionStreamConstructor
    }
  ).DecompressionStream
  if (!DecompressionStreamCtor) {
    throw new Error('Runtime RPC gzip decompression is not supported')
  }

  const binary = window.atob(result.payload)
  const payload = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    payload[index] = binary.charCodeAt(index)
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payload)
      controller.close()
    },
  })
  const stream = source.pipeThrough(new DecompressionStreamCtor('gzip'))
  const decoded = await new Response(stream).text()
  return JSON.parse(decoded) as T
}

function isCompressedRuntimeIpcResult(
  result: unknown
): result is { __runtimeRpcEncoding: string; payload: string } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false
  }
  const value = result as Record<string, unknown>
  return (
    value.__runtimeRpcEncoding === RUNTIME_RPC_COMPRESSED_ENCODING &&
    typeof value.payload === 'string'
  )
}

function resolveRelayTimeoutSeconds(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): number {
  if (method !== 'device.execute_command') {
    return Math.ceil(timeoutMs / 1000)
  }
  const requested = params.timeout_seconds
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return Math.ceil(ACK_TIMEOUT_MS / 1000)
  }
  return Math.min(Math.ceil(requested), MAX_COMMAND_TIMEOUT_SECONDS)
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
