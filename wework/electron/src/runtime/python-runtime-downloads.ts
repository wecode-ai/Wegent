export interface PythonRuntimeDownloads {
  uvDownloadBaseUrl: string
  pythonInstallMirror: string
}

export const PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS = 200

interface DownloadConfigOptions {
  connection: () => Promise<unknown>
  environment: NodeJS.ProcessEnv
  backendUrl?: string
  fetch: typeof fetch
}

function backendApiUrl(connection: unknown, options: DownloadConfigOptions): string {
  const stored = connection as { apiBaseUrl?: unknown } | null
  if (typeof stored?.apiBaseUrl === 'string' && stored.apiBaseUrl.trim()) {
    return httpUrl(stored.apiBaseUrl, 'Backend API URL').href.replace(/\/+$/, '')
  }
  const configured =
    options.environment.WEWORK_BACKEND_URL?.trim() ||
    options.environment.WEGENT_BACKEND_URL?.trim() ||
    options.environment.VITE_WEGENT_BACKEND_URL?.trim() ||
    options.backendUrl
  const url = httpUrl(configured, 'Backend URL')
  const segments = url.pathname.split('/').filter(Boolean)
  const api = segments.indexOf('api')
  url.pathname = `/${(api >= 0 ? segments.slice(0, api + 1) : [...segments, 'api']).join('/')}`
  return url.href.replace(/\/+$/, '')
}

function httpUrl(value: unknown, name: string): URL {
  let url: URL
  try {
    if (typeof value !== 'string' || !value.trim()) throw new Error()
    url = new URL(value.trim())
  } catch {
    throw new Error(`Python download configuration: invalid ${name}`)
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Python download configuration: invalid ${name}`)
  }
  return url
}

function downloadDirectory(value: unknown, name: string): string {
  const url = httpUrl(value, name)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.href
}

/** This independent request never changes the existing login/config request path. */
export async function fetchPythonRuntimeDownloads(
  options: DownloadConfigOptions
): Promise<PythonRuntimeDownloads> {
  const controller = new AbortController()
  const deadline = performance.now() + PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS
  const timeoutError = () =>
    new Error(
      `Python download configuration timed out after ${PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS}ms`
    )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError())
      controller.abort()
    }, PYTHON_DOWNLOAD_CONFIG_TIMEOUT_MS)
  })
  const load = async (): Promise<PythonRuntimeDownloads> => {
    const api = backendApiUrl(await options.connection(), options)
    controller.signal.throwIfAborted()
    const response = await options.fetch(`${api}/auth/wework/config`, {
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Python download configuration: HTTP ${response.status}`)
    const payload = (await response.json()) as {
      runtime_downloads?: Partial<PythonRuntimeDownloads>
    } | null
    const downloads = {
      uvDownloadBaseUrl: downloadDirectory(
        payload?.runtime_downloads?.uvDownloadBaseUrl,
        'uvDownloadBaseUrl'
      ),
      pythonInstallMirror: downloadDirectory(
        payload?.runtime_downloads?.pythonInstallMirror,
        'pythonInstallMirror'
      ),
    }
    // Never use metadata from a backend that was replaced while the request was pending.
    if (backendApiUrl(await options.connection(), options) !== api) {
      throw new Error('Python download configuration: Backend changed during request')
    }
    controller.signal.throwIfAborted()
    if (performance.now() >= deadline) {
      controller.abort()
      throw timeoutError()
    }
    return downloads
  }
  try {
    return await Promise.race([load(), timeout])
  } finally {
    clearTimeout(timer)
  }
}
