export interface BackendConfig {
  backendUrl: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  webUrl?: string
}

export interface RuntimeSessionConfig extends BackendConfig {
  accessToken: string
}

interface BackendMetadata {
  web_url?: unknown
  socket_url?: unknown
}

export function configuredBackendUrl(): string | null {
  return process.env.EXPO_PUBLIC_BACKEND_URL?.trim() || null
}

export function normalizeBackendUrl(input: string, socketOverride?: string): BackendConfig {
  const value = ensureProtocol(input.trim())
  const url = parseHttpUrl(value, 'Backend 地址无效')
  const path = url.pathname.replace(/\/+$/, '')
  const segments = path.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  const backendSegments = apiIndex >= 0 ? segments.slice(0, apiIndex) : segments
  const backendPath = backendSegments.length ? `/${backendSegments.join('/')}` : ''
  const apiPath = apiIndex >= 0 ? `${backendPath}/api` : `${backendPath}/api`
  const backendUrl = trimTrailingSlash(`${url.origin}${backendPath}`)

  return {
    backendUrl,
    apiBaseUrl: trimTrailingSlash(`${url.origin}${apiPath}`),
    socketBaseUrl: socketOverride?.trim()
      ? normalizeSocketUrl(socketOverride)
      : backendUrl || url.origin,
    socketPath: '/socket.io',
  }
}

export async function resolveBackendConfig(input: string): Promise<BackendConfig> {
  const initial = normalizeBackendUrl(input)
  const response = await fetch(`${initial.apiBaseUrl}/auth/wework/config`)
  const metadata = await responseJson<BackendMetadata>(response)
  if (!response.ok) throw new Error(errorMessage(metadata, response.status))
  if (typeof metadata.web_url !== 'string' || !metadata.web_url.trim()) {
    throw new Error('Backend 没有返回 Wegent Web 地址')
  }
  const socketUrl =
    typeof metadata.socket_url === 'string' && metadata.socket_url.trim()
      ? metadata.socket_url.trim()
      : undefined
  return {
    ...normalizeBackendUrl(input, socketUrl),
    webUrl: metadata.web_url.trim().replace(/\/+$/, ''),
  }
}

export async function checkBackendHealth(config: BackendConfig): Promise<void> {
  const response = await fetch(`${config.apiBaseUrl}/health`)
  if (!response.ok) throw new Error(`Backend 健康检查失败 (${response.status})`)
}

export async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`Backend 返回了无效 JSON (${response.status})`)
  }
}

export function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const detail = (body as Record<string, unknown>).detail
    if (typeof detail === 'string') return detail
  }
  return `Backend 请求失败 (${status})`
}

function normalizeSocketUrl(value: string): string {
  const url = new URL(ensureProtocol(value.trim()))
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('Socket 地址无效')
  }
  return trimTrailingSlash(url.toString())
}

function parseHttpUrl(value: string, message: string): URL {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(message)
    return url
  } catch {
    throw new Error(message)
  }
}

function ensureProtocol(value: string): string {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(value) ? value : `http://${value}`
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
