import { CloudCredentialError } from './cloud-credential-service.js'

const REQUEST_ORIGIN = 'https://wework-sync.local'
export const WEWORK_SYNC_REQUEST_TIMEOUT_MS = 30_000

export function createWeworkSyncRequestSignal(
  timeoutMs = WEWORK_SYNC_REQUEST_TIMEOUT_MS
): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

export function normalizeWeworkSyncApiBaseUrl(value: string): string {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
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

function pathNotAllowed(): CloudCredentialError {
  return new CloudCredentialError('request_failed', 'Wework sync path is not allowed')
}
