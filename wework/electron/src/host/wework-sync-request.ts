import { CloudCredentialError } from './cloud-credential-service.js'
import { createWriteStream, openAsBlob } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REQUEST_ORIGIN = 'https://wework-sync.local'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])
export const WEWORK_SYNC_REQUEST_TIMEOUT_MS = 30_000

export interface WeworkSyncRequest {
  apiBaseUrl: string
  path: string
  method: 'GET' | 'POST' | 'PUT'
  body?: unknown
  downloadPath?: string
  downloadSizeBytes?: number
  file?: {
    path: string
    name: string
    contentType: string
  }
}

export async function readWeworkSyncResponse(
  response: Response,
  downloadPath?: string,
  downloadSizeBytes?: number,
  onDownloadProgress?: () => void
): Promise<unknown> {
  if (downloadPath && response.ok) {
    if (!response.body) {
      throw new CloudCredentialError('request_failed', 'Wework sync download body is missing')
    }
    if (
      typeof downloadSizeBytes !== 'number' ||
      !Number.isSafeInteger(downloadSizeBytes) ||
      downloadSizeBytes < 1
    ) {
      throw new CloudCredentialError('request_failed', 'Wework sync download size is invalid')
    }
    const expectedSizeBytes = downloadSizeBytes
    let receivedBytes = 0
    onDownloadProgress?.()
    const sizeLimit = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length
        if (receivedBytes > expectedSizeBytes) {
          callback(
            new CloudCredentialError(
              'request_failed',
              'Wework sync download exceeds its declared size'
            )
          )
          return
        }
        onDownloadProgress?.()
        callback(null, chunk)
      },
      flush(callback) {
        if (receivedBytes !== expectedSizeBytes) {
          callback(
            new CloudCredentialError(
              'request_failed',
              'Wework sync download does not match its declared size'
            )
          )
          return
        }
        callback()
      },
    })
    await pipeline(
      Readable.from(response.body as AsyncIterable<Uint8Array>),
      sizeLimit,
      createWriteStream(downloadPath, { mode: 0o600 })
    )
    return { path: downloadPath }
  }
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function createWeworkSyncRequestSignal(
  timeoutMs = WEWORK_SYNC_REQUEST_TIMEOUT_MS
): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

export function createWeworkSyncDownloadTimeout(timeoutMs = WEWORK_SYNC_REQUEST_TIMEOUT_MS): {
  signal: AbortSignal
  refresh: () => void
  clear: () => void
} {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const refresh = () => {
    clear()
    timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref()
  }
  refresh()
  return { signal: controller.signal, refresh, clear }
}

export function normalizeWeworkSyncApiBaseUrl(value: string): string {
  const url = new URL(value.trim())
  const secureTransport =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  if (!secureTransport || url.username || url.password) {
    throw new CloudCredentialError('request_failed', 'Invalid Wework sync API URL')
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function normalizeWeworkSyncPath(value: string): string {
  const input = value.trim()
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('#')) {
    throw pathNotAllowed()
  }
  const url = new URL(input, REQUEST_ORIGIN)
  if (
    url.origin !== REQUEST_ORIGIN ||
    (!(url.pathname === '/wework-transcripts' || url.pathname.startsWith('/wework-transcripts/')) &&
      !url.pathname.startsWith('/v1/dsh-plugin-storage/'))
  ) {
    throw pathNotAllowed()
  }
  return `${url.pathname}${url.search}`
}

export async function createWeworkSyncFetchInit(
  request: WeworkSyncRequest,
  authorization: string,
  signal?: AbortSignal
): Promise<RequestInit> {
  if (request.file) {
    if (request.body === undefined) {
      throw new CloudCredentialError('request_failed', 'Wework sync upload metadata is missing')
    }
    const form = new FormData()
    form.append('metadata', JSON.stringify(request.body))
    form.append(
      'file',
      await openAsBlob(request.file.path, { type: request.file.contentType }),
      request.file.name
    )
    return {
      method: request.method,
      signal: signal ?? createWeworkSyncRequestSignal(10 * 60 * 1000),
      headers: { authorization },
      body: form,
    }
  }
  return {
    method: request.method,
    signal: signal ?? createWeworkSyncRequestSignal(),
    headers: {
      authorization,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  }
}

function pathNotAllowed(): CloudCredentialError {
  return new CloudCredentialError('request_failed', 'Wework sync path is not allowed')
}
