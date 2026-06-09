import { removeToken } from './auth'
import { redirectToLogin } from '@/features/auth/redirect'

export class ApiError extends Error {
  status: number
  errorCode?: string | number

  constructor(message: string, status: number, errorCode?: string | number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.errorCode = errorCode
  }
}

export interface HttpClientOptions {
  baseUrl: string
  getToken?: () => string | null
}

export interface HttpClient {
  get<T>(endpoint: string): Promise<T>
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

  try {
    const json = JSON.parse(errorText)
    if (typeof json.detail === 'string') {
      message = json.detail
    } else if (json.detail?.error_code) {
      message = String(json.detail.error_code)
      errorCode = json.detail.error_code
    }
    if (json.error_code) {
      errorCode = json.error_code
    }
  } catch {
    message = errorText || `HTTP ${response.status}`
  }

  return new ApiError(message, response.status, errorCode)
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const getToken = options.getToken ?? defaultGetToken
  const inFlightGetRequests = new Map<string, Promise<unknown>>()

  async function request<T>(endpoint: string, init: RequestInit): Promise<T> {
    const token = getToken()
    const isFormData = init.body instanceof FormData
    const response = await fetch(`${options.baseUrl}${endpoint}`, {
      ...init,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })

    if (!response.ok) {
      const error = await parseError(response)
      if (response.status === 401) {
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

  function get<T>(endpoint: string): Promise<T> {
    const token = getToken()
    const cacheKey = `${token ?? ''}:${endpoint}`
    const currentRequest = inFlightGetRequests.get(cacheKey)
    if (currentRequest) {
      return currentRequest as Promise<T>
    }

    const nextRequest = request<T>(endpoint, { method: 'GET' }).finally(() => {
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
          data === undefined
            ? undefined
            : data instanceof FormData
              ? data
              : JSON.stringify(data),
      }),
    put: (endpoint, data) =>
      request(endpoint, {
        method: 'PUT',
        body:
          data === undefined
            ? undefined
            : data instanceof FormData
              ? data
              : JSON.stringify(data),
      }),
    delete: endpoint => request(endpoint, { method: 'DELETE' }),
  }
}
