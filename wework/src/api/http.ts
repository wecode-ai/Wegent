import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { removeToken } from './auth'
import { redirectToLogin } from '@/features/auth/redirect'
import { isTauriRuntime } from '@/lib/runtime-environment'

const SLOW_HTTP_REQUEST_MS = 5000
let requestSequence = 0

// In a packaged Tauri app the WebView calls the API cross-origin, which
// triggers CORS preflight. Routing through the Tauri (Rust) HTTP client
// bypasses the WebView same-origin policy entirely. Outside Tauri (browser
// dev server via Vite proxy, vitest) fall back to the global fetch.
export function shouldUseTauriFetch(): boolean {
  return import.meta.env.MODE !== 'test' && isTauriRuntime()
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function createRequestId(): string {
  requestSequence += 1
  return `wework-${Date.now().toString(36)}-${requestSequence.toString(36)}`
}

function transportName(): 'tauri-http-ipc' | 'fetch' {
  return shouldUseTauriFetch() ? 'tauri-http-ipc' : 'fetch'
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause ? { cause: String(error.cause) } : {}),
    }
  }
  return { message: String(error) }
}

interface HttpRequestLogContext {
  requestId: string
  method: string
  baseUrl: string
  endpoint: string
  startedAt: number
}

interface HttpResponseDiagnostics {
  response: Response
  logContext: HttpRequestLogContext
  backendRequestId: string | null
}

interface HttpFetchOptions {
  token: string | null
  signal?: AbortSignal
  contentType?: string | null
}

function requestLogFields(
  context: HttpRequestLogContext,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    requestId: context.requestId,
    method: context.method,
    baseUrl: context.baseUrl,
    endpoint: context.endpoint,
    elapsedMs: Math.round(nowMs() - context.startedAt),
    transport: transportName(),
    ...fields,
  }
}

function requestUrl(baseUrl: string, endpoint: string): string {
  const rawUrl = `${baseUrl}${endpoint}`
  if (!shouldUseTauriFetch() || /^[a-z][a-z\d+\-.]*:\/\//i.test(rawUrl)) {
    return rawUrl
  }

  return new URL(rawUrl, window.location.origin).toString()
}

function httpFetch(): typeof fetch {
  return shouldUseTauriFetch() ? tauriFetch : globalThis.fetch.bind(globalThis)
}

export class ApiError extends Error {
  status: number
  errorCode?: string | number
  detail?: unknown

  constructor(message: string, status: number, errorCode?: string | number, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorCode = errorCode
    this.detail = detail
  }
}

export interface HttpClientOptions {
  baseUrl: string
  getToken?: () => string | null
  redirectOnUnauthorized?: boolean
}

export interface HttpRequestOptions {
  redirectOnUnauthorized?: boolean
  signal?: AbortSignal
}

export interface HttpClient {
  get<T>(endpoint: string, options?: HttpRequestOptions): Promise<T>
  getBlob(endpoint: string): Promise<Blob>
  post<T>(endpoint: string, data?: unknown): Promise<T>
  put<T>(endpoint: string, data?: unknown): Promise<T>
  patch<T>(endpoint: string, data?: unknown): Promise<T>
  delete<T>(endpoint: string, data?: unknown): Promise<T>
}

function defaultGetToken(): string | null {
  return localStorage.getItem('auth_token')
}

async function parseError(response: Response): Promise<ApiError> {
  const errorText = await response.text()
  let message = errorText
  let errorCode: string | number | undefined
  let detail: unknown

  try {
    const json = JSON.parse(errorText)
    detail = json.errors ? { detail: json.detail, errors: json.errors } : json.detail
    if (typeof json.detail === 'string') {
      message = json.detail
    } else if (json.detail && typeof json.detail === 'object') {
      if (typeof json.detail.message === 'string') {
        message = json.detail.message
      }
      if (json.detail.error_code || json.detail.code) {
        errorCode = json.detail.error_code ?? json.detail.code
      }
    }
    if (json.error_code) {
      errorCode = json.error_code
    }
    if (json.error && typeof json.error === 'object') {
      detail = json.error
      if (typeof json.error.message === 'string') {
        message = json.error.message
      }
      if (json.error.code || json.error.error_code) {
        errorCode = json.error.code ?? json.error.error_code
      }
    }
  } catch {
    message = errorText || `HTTP ${response.status}`
  }

  return new ApiError(message, response.status, errorCode, detail)
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const getToken = options.getToken ?? defaultGetToken
  const inFlightGetRequests = new Map<string, Promise<unknown>>()

  async function fetchWithDiagnostics(
    endpoint: string,
    init: RequestInit,
    fetchOptions: HttpFetchOptions
  ): Promise<HttpResponseDiagnostics> {
    const { token, signal } = fetchOptions
    const isFormData = init.body instanceof FormData
    const method = init.method ?? 'GET'
    const startedAt = nowMs()
    const requestId = createRequestId()
    const logContext = {
      requestId,
      method,
      baseUrl: options.baseUrl,
      endpoint,
      startedAt,
    }
    const slowTimer = window.setTimeout(() => {
      console.warn(
        `[Wework] HTTP ${method} ${endpoint} is still pending after ${SLOW_HTTP_REQUEST_MS}ms.`,
        requestLogFields(logContext, { phase: 'waiting_for_response' })
      )
    }, SLOW_HTTP_REQUEST_MS)
    let response: Response
    try {
      response = await httpFetch()(requestUrl(options.baseUrl, endpoint), {
        ...init,
        ...(signal ? { signal } : {}),
        headers: {
          ...(fetchOptions.contentType === undefined
            ? isFormData
              ? {}
              : { 'Content-Type': 'application/json' }
            : fetchOptions.contentType
              ? { 'Content-Type': fetchOptions.contentType }
              : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(shouldUseTauriFetch() ? { 'X-Request-ID': requestId } : {}),
          ...init.headers,
        },
      })
    } catch (error) {
      window.clearTimeout(slowTimer)
      console.warn(
        `[Wework] HTTP ${method} ${endpoint} failed.`,
        requestLogFields(logContext, {
          phase: 'transport',
          error: errorDetails(error),
        })
      )
      throw error
    }
    window.clearTimeout(slowTimer)
    const elapsedMs = Math.round(nowMs() - startedAt)
    const backendRequestId = response.headers?.get?.('X-Request-ID') || null
    if (elapsedMs >= SLOW_HTTP_REQUEST_MS) {
      console.warn(
        `[Wework] HTTP ${method} ${endpoint} completed slowly in ${elapsedMs}ms.`,
        requestLogFields(logContext, {
          phase: 'response_received',
          status: response.status,
          backendRequestId,
          serverTiming: response.headers?.get?.('Server-Timing') || null,
        })
      )
    }

    return { response, logContext, backendRequestId }
  }

  async function parseAndLogHttpError(
    response: Response,
    diagnostics: HttpResponseDiagnostics
  ): Promise<ApiError> {
    const error = await parseError(response)
    console.warn(
      `[Wework] HTTP ${diagnostics.logContext.method} ${diagnostics.logContext.endpoint} returned ${response.status}.`,
      requestLogFields(diagnostics.logContext, {
        phase: 'http_error',
        status: response.status,
        backendRequestId: diagnostics.backendRequestId,
        error: errorDetails(error),
      })
    )
    return error
  }

  async function request<T>(
    endpoint: string,
    init: RequestInit,
    requestOptions: HttpRequestOptions = {}
  ): Promise<T> {
    const diagnostics = await fetchWithDiagnostics(endpoint, init, {
      token: getToken(),
      signal: requestOptions.signal,
    })
    const { response } = diagnostics

    if (!response.ok) {
      const error = await parseAndLogHttpError(response, diagnostics)
      const redirectOnUnauthorized =
        requestOptions.redirectOnUnauthorized ?? options.redirectOnUnauthorized ?? true
      if (response.status === 401 && redirectOnUnauthorized) {
        removeToken()
        redirectToLogin()
      }
      throw error
    }

    if (response.status === 204) {
      return null as T
    }

    return response.json() as Promise<T>
  }

  function get<T>(endpoint: string, requestOptions: HttpRequestOptions = {}): Promise<T> {
    const token = getToken()
    const redirectKey = requestOptions.redirectOnUnauthorized === false ? 'no-redirect' : 'redirect'
    const cacheKey = `${redirectKey}:${token ?? ''}:${endpoint}`
    if (!requestOptions.signal) {
      const currentRequest = inFlightGetRequests.get(cacheKey)
      if (currentRequest) {
        return currentRequest as Promise<T>
      }
    }

    const nextRequest = request<T>(endpoint, { method: 'GET' }, requestOptions).finally(() => {
      if (!requestOptions.signal) {
        inFlightGetRequests.delete(cacheKey)
      }
    })
    if (!requestOptions.signal) {
      inFlightGetRequests.set(cacheKey, nextRequest)
    }
    return nextRequest
  }

  async function getBlob(endpoint: string): Promise<Blob> {
    const diagnostics = await fetchWithDiagnostics(
      endpoint,
      {},
      {
        token: getToken(),
        contentType: null,
      }
    )
    if (!diagnostics.response.ok) {
      throw await parseAndLogHttpError(diagnostics.response, diagnostics)
    }
    return diagnostics.response.blob()
  }

  return {
    get,
    getBlob,
    post: (endpoint, data) =>
      request(endpoint, {
        method: 'POST',
        body:
          data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
      }),
    put: (endpoint, data) =>
      request(endpoint, {
        method: 'PUT',
        body:
          data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
      }),
    patch: (endpoint, data) =>
      request(endpoint, {
        method: 'PATCH',
        body:
          data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
      }),
    delete: (endpoint, data) =>
      request(endpoint, {
        method: 'DELETE',
        body: data === undefined ? undefined : JSON.stringify(data),
      }),
  }
}
