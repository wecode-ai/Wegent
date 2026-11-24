const REQUEST_TIMEOUT_MS = 15_000
const RESPONSE_LIMIT = 2 * 1024 * 1024

type HttpScalar = string | number | boolean

export interface ConnectionHttpOperation {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, HttpScalar>
  json?: unknown
}

type SessionFetch = (url: string, options: RequestInit) => Promise<Response>

const CSRF_HEADERS = ['x-csrftoken', 'x-csrf-token', 'x-xsrf-token'] as const

export interface ConnectionCsrfBinding {
  header: (typeof CSRF_HEADERS)[number]
  cookie: string
}

interface ConnectionCookie {
  name: string
  value: string
  httpOnly?: boolean
}

export type ConnectionCookieReader = (url: string) => Promise<ConnectionCookie[]>

function decodedCookie(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export async function recordedCsrfBinding(
  headers: Record<string, unknown>,
  url: string,
  cookies: ConnectionCookieReader
): Promise<ConnectionCsrfBinding | undefined> {
  const recorded = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (CSRF_HEADERS.some(header => header === name.toLowerCase()) && typeof value === 'string')
      recorded.set(name, value)
  }
  const header = CSRF_HEADERS.find(name => recorded.get(name))
  if (!header) return
  const value = recorded.get(header)
  const matches = (await cookies(url)).filter(
    cookie => !cookie.httpOnly && (cookie.value === value || decodedCookie(cookie.value) === value)
  )
  if (matches.length === 1) return { header, cookie: matches[0].name }
}

async function csrfHeaders(
  target: URL,
  binding: ConnectionCsrfBinding,
  cookies: ConnectionCookieReader
): Promise<Record<string, string>> {
  if (!CSRF_HEADERS.includes(binding.header))
    throw new ConnectionHttpError('invalid_connection_http', 'Invalid CSRF header')
  const matches = (await cookies(target.href)).filter(
    cookie => !cookie.httpOnly && cookie.name === binding.cookie && cookie.value
  )
  if (matches.length !== 1)
    throw new ConnectionHttpError(
      'connector_auth_required',
      'Open the site to refresh this session'
    )
  return { origin: target.origin, [binding.header]: decodedCookie(matches[0].value) }
}

export class ConnectionHttpError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function requestUrl(origin: string, operation: ConnectionHttpOperation): URL {
  const base = URL.parse(origin)
  if (
    !base ||
    base.origin !== origin ||
    (base.protocol !== 'https:' && base.protocol !== 'http:') ||
    !operation.path.startsWith('/') ||
    /[\\?#]|%2f|%5c/i.test(operation.path)
  ) {
    throw new ConnectionHttpError('invalid_connection_http', 'Invalid connection HTTP target')
  }
  const target = URL.parse(operation.path, base)
  if (!target || target.origin !== origin || target.pathname !== operation.path) {
    throw new ConnectionHttpError('invalid_connection_http', 'Invalid connection HTTP path')
  }
  for (const [name, value] of Object.entries(operation.query ?? {})) {
    if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 8192) {
      throw new ConnectionHttpError('invalid_connection_http', 'Invalid connection HTTP parameter')
    }
    target.searchParams.append(name, String(value))
  }
  return target
}

async function readJson(response: Response): Promise<unknown> {
  if (
    !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(
      response.headers.get('content-type') ?? ''
    )
  ) {
    await response.body?.cancel()
    throw new ConnectionHttpError('connection_response_invalid', 'Expected a JSON response')
  }
  if (!response.body) {
    throw new ConnectionHttpError('connection_response_invalid', 'The site returned no data')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > RESPONSE_LIMIT) {
        await reader.cancel()
        throw new ConnectionHttpError('connection_response_invalid', 'The response is too large')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(text + decoder.decode())
  } catch {
    throw new ConnectionHttpError('connection_response_invalid', 'The site returned invalid JSON')
  }
}

/** Called with a host-authorized origin and an operation materialized from the approved definition. */
export async function fetchConnectionJson(
  fetchInSession: SessionFetch,
  origin: string,
  operation: ConnectionHttpOperation,
  csrf?: { binding: ConnectionCsrfBinding; cookies: ConnectionCookieReader }
): Promise<unknown> {
  const url = requestUrl(origin, operation)
  const { method, json } = operation
  if ((method !== 'GET' && method !== 'POST') || (method === 'GET' && json !== undefined)) {
    throw new ConnectionHttpError('invalid_connection_http', 'Invalid connection HTTP method')
  }
  const body = json === undefined ? undefined : JSON.stringify(json)
  if (url.href.length > 16384 || (body !== undefined && Buffer.byteLength(body) > 262144)) {
    throw new ConnectionHttpError('invalid_connection_http', 'The request is too large')
  }
  const response = await fetchInSession(url.href, {
    method,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' && csrf ? await csrfHeaders(url, csrf.binding, csrf.cookies) : {}),
    },
    credentials: 'include',
    redirect: 'manual',
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) {
      throw new ConnectionHttpError('connector_auth_required', 'The site rejected this session')
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new ConnectionHttpError('connection_http_redirect', 'The site redirected the request')
    }
    throw new ConnectionHttpError(
      'connection_http_failed',
      `The site returned HTTP ${response.status}`
    )
  }
  return readJson(response)
}
