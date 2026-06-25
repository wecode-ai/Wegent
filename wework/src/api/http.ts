import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { removeToken } from './auth'
import { redirectToLogin } from '@/features/auth/redirect'
import { isTauriRuntime } from '@/lib/runtime-environment'

// In a packaged Tauri app the WebView calls the API cross-origin, which
// triggers CORS preflight. Routing through the Tauri (Rust) HTTP client
// bypasses the WebView same-origin policy entirely. Outside Tauri (browser
// dev server via Vite proxy, vitest) fall back to the global fetch.
export function shouldUseTauriFetch(): boolean {
  return import.meta.env.MODE !== 'test' && isTauriRuntime()
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
}

export interface HttpRequestOptions {
  redirectOnUnauthorized?: boolean
}

export interface HttpClient {
  get<T>(endpoint: string, options?: HttpRequestOptions): Promise<T>
  post<T>(endpoint: string, data?: unknown): Promise<T>
  put<T>(endpoint: string, data?: unknown): Promise<T>
  delete<T>(endpoint: string): Promise<T>
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
    detail = json.detail
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
  } catch {
    message = errorText || `HTTP ${response.status}`
  }

  return new ApiError(message, response.status, errorCode, detail)
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const getToken = options.getToken ?? defaultGetToken
  const inFlightGetRequests = new Map<string, Promise<unknown>>()

  async function request<T>(
    endpoint: string,
    init: RequestInit,
    requestOptions: HttpRequestOptions = {}
  ): Promise<T> {
    const token = getToken()
    const isFormData = init.body instanceof FormData
    const response = await httpFetch()(requestUrl(options.baseUrl, endpoint), {
      ...init,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) {
      const error = await parseError(response)
      if (response.status === 401 && requestOptions.redirectOnUnauthorized !== false) {
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
    const currentRequest = inFlightGetRequests.get(cacheKey)
    if (currentRequest) {
      return currentRequest as Promise<T>
    }

    const nextRequest = request<T>(endpoint, { method: 'GET' }, requestOptions).finally(() => {
      inFlightGetRequests.delete(cacheKey)
    })
    inFlightGetRequests.set(cacheKey, nextRequest)
    return nextRequest
  }

  return {
    get,
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
    delete: endpoint => request(endpoint, { method: 'DELETE' }),
  }
}
