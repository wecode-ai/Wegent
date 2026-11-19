import { pythonArtifact } from './python-runtime-artifacts.js'

export interface PythonRuntimeDownloads {
  uvUrl: string
  pythonUrl: string
}

export class PythonRuntimeLoginRequiredError extends Error {
  readonly code = 'python_runtime_login_required'
  constructor() {
    super('Sign in to Wegent before downloading managed Python')
  }
}

export const PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS = 200

export class PythonRuntimeDownloadTimeoutError extends Error {
  readonly code = 'python_runtime_download_timeout'
  constructor() {
    super(`Python download configuration timed out after ${PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS}ms`)
  }
}

interface DownloadConfigOptions {
  connection: () => Promise<unknown>
  accessToken: (apiBaseUrl: string, connection: Record<string, unknown>) => Promise<string>
  fetch: typeof fetch
  platform?: string
  arch?: string
}

function httpUrl(value: unknown, name: string, query = false): URL {
  try {
    if (typeof value !== 'string' || !value.trim()) throw new Error()
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (!query && url.search)
    )
      throw new Error()
    return url
  } catch {
    throw new Error(`Python download configuration: invalid ${name}`)
  }
}

function apiUrl(connection: unknown): string {
  const stored = connection as { apiBaseUrl?: unknown } | null
  if (!stored?.apiBaseUrl) throw new PythonRuntimeLoginRequiredError()
  return httpUrl(stored.apiBaseUrl, 'Backend API URL').href.replace(/\/+$/, '')
}

export function validatePythonRuntimeDownloads(
  value: unknown,
  platform = process.platform,
  arch: string = process.arch
): PythonRuntimeDownloads {
  const data = value as Partial<PythonRuntimeDownloads> | null
  const python = pythonArtifact(platform, arch)
  const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : platform === 'linux' ? 'unknown-linux-gnu' : 'pc-windows-msvc'}`
  const filenames = {
    uvUrl: `uv-${target}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
    pythonUrl: python.filename,
  }
  for (const key of ['uvUrl', 'pythonUrl'] as const) {
    const url = httpUrl(data?.[key], key, true)
    if (
      decodeURIComponent(url.pathname.split('/').at(-1) ?? '') !==
      decodeURIComponent(filenames[key])
    )
      throw new Error(`Python download configuration: invalid ${key} artifact`)
  }
  // Keep opaque query signatures byte-for-byte; never join or normalize artifact URLs.
  return { uvUrl: data!.uvUrl!, pythonUrl: data!.pythonUrl! }
}

async function metadataRequest<Result>(
  load: (signal: AbortSignal) => Promise<Result>
): Promise<Result> {
  const controller = new AbortController()
  const deadline = performance.now() + PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS
  const error = () => new PythonRuntimeDownloadTimeoutError()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(error())
      controller.abort()
    }, PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([load(controller.signal), timeout])
    if (performance.now() >= deadline) {
      controller.abort()
      throw error()
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/** Credential refresh keeps its existing budget; only the new descriptor request uses 200ms. */
export async function fetchPythonRuntimeDownloads(
  options: DownloadConfigOptions
): Promise<PythonRuntimeDownloads> {
  const connection = await options.connection()
  const api = apiUrl(connection)
  const token = await options.accessToken(api, connection as Record<string, unknown>)
  if (!token.trim()) throw new PythonRuntimeLoginRequiredError()
  if (apiUrl(await options.connection()) !== api)
    throw new Error('Python download configuration: Backend changed during request')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const startedAt = performance.now()
  let phase = 'headers'
  let headersMs: number | undefined
  const payload = await metadataRequest(async signal => {
    const response = await options.fetch(`${api}/wework/runtime-downloads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ platform, arch, uvVersion: '0.9.5', pythonVersion: '3.12.12' }),
      signal,
    })
    headersMs = performance.now() - startedAt
    phase = 'body'
    if (response.status === 401) throw new PythonRuntimeLoginRequiredError()
    if (!response.ok) throw new Error(`Python download configuration: HTTP ${response.status}`)
    const payload = await response.json().catch(() => {
      throw new Error('Python download configuration: invalid response')
    })
    phase = 'completed'
    return payload
  }).catch(error => {
    if (error instanceof PythonRuntimeDownloadTimeoutError)
      console.warn('[python-runtime]', {
        event: 'python-runtime-download-config-timeout',
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        headersMs: headersMs == null ? undefined : Math.round(headersMs),
      })
    throw error
  })
  if (payload?.uv?.version !== '0.9.5' || payload?.python?.version !== '3.12.12')
    throw new Error('Python download configuration: invalid runtime version')
  if (apiUrl(await options.connection()) !== api)
    throw new Error('Python download configuration: Backend changed during request')
  if (
    payload.expiresAt != null &&
    (!Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now())
  )
    throw new Error('Python download configuration: expired download addresses')
  return validatePythonRuntimeDownloads(
    { uvUrl: payload?.uv?.url, pythonUrl: payload?.python?.url },
    platform as NodeJS.Platform,
    arch
  )
}

/** Development windows obtain addresses through the parent, never its login credentials. */
export async function fetchParentPythonRuntimeDownloads(
  environment: NodeJS.ProcessEnv,
  request: typeof fetch,
  platform = process.platform,
  arch: string = process.arch
): Promise<PythonRuntimeDownloads> {
  const url = httpUrl(environment.WEWORK_PARENT_PYTHON_DOWNLOADS_URL, 'parent download endpoint')
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/runtime/python/downloads' ||
    !environment.WEWORK_PARENT_PYTHON_DOWNLOADS_TOKEN
  )
    throw new Error('Invalid parent Python download endpoint')
  const response = await request(url.href, {
    method: 'POST',
    headers: { authorization: `Bearer ${environment.WEWORK_PARENT_PYTHON_DOWNLOADS_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok)
    throw new Error(`Parent Python download request failed: HTTP ${response.status}`)
  const payload = await response.json().catch(() => {
    throw new Error('Parent Python download response is invalid')
  })
  if (payload.code === 'python_runtime_login_required') throw new PythonRuntimeLoginRequiredError()
  if (!payload.ok) throw new Error('Parent Python download addresses are unavailable')
  return validatePythonRuntimeDownloads(payload.data, platform, arch)
}
