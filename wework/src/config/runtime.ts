export type RuntimeMode = 'local-first' | 'backend'

export interface RuntimeConfig {
  appBasePath: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
  wegentBackendUrl: string
  runtimeMode: RuntimeMode
  loginMode: 'password' | 'oidc' | 'all'
  oidcLoginText: string
  cloudDeviceScalingWikiUrl: string
}

type RuntimeConfigOverrides = Partial<RuntimeConfig>

declare global {
  interface Window {
    __WEWORK_RUNTIME_CONFIG__?: RuntimeConfigOverrides
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function runtimeOverrides(): RuntimeConfigOverrides {
  if (typeof window === 'undefined') {
    return {}
  }

  return window.__WEWORK_RUNTIME_CONFIG__ ?? {}
}

function runtimeString(
  overrides: RuntimeConfigOverrides,
  key: keyof RuntimeConfig
): string | undefined {
  const value = overrides[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isValidLoginMode(value: string): value is RuntimeConfig['loginMode'] {
  return value === 'password' || value === 'oidc' || value === 'all'
}

function isValidRuntimeMode(value: string): value is RuntimeMode {
  return value === 'local-first' || value === 'backend'
}

function resolveRuntimeMode(overrides: RuntimeConfigOverrides): RuntimeMode {
  const runtimeValue = runtimeString(overrides, 'runtimeMode')
  if (runtimeValue && isValidRuntimeMode(runtimeValue)) {
    return runtimeValue
  }

  const envValue = import.meta.env.VITE_WEWORK_RUNTIME_MODE
  if (envValue && isValidRuntimeMode(envValue)) {
    return envValue
  }

  return 'local-first'
}

function resolveLoginMode(overrides: RuntimeConfigOverrides): RuntimeConfig['loginMode'] {
  const runtimeValue = runtimeString(overrides, 'loginMode')
  if (runtimeValue && isValidLoginMode(runtimeValue)) {
    return runtimeValue
  }

  const envValue = import.meta.env.VITE_LOGIN_MODE
  if (envValue && isValidLoginMode(envValue)) {
    return envValue
  }

  return 'all'
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') {
    return ''
  }

  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`
  return trimTrailingSlash(withLeadingSlash)
}

export function joinAppPath(basePath: string, path: string): string {
  const normalizedBasePath = normalizeBasePath(basePath)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (!normalizedBasePath) {
    return normalizedPath
  }

  if (normalizedPath === '/') {
    return `${normalizedBasePath}/`
  }

  return `${normalizedBasePath}${normalizedPath}`
}

export function stripAppBasePath(path: string): string {
  const appBasePath = getRuntimeConfig().appBasePath
  if (!appBasePath || path === appBasePath) {
    return path === appBasePath ? '/' : path
  }

  if (path.startsWith(`${appBasePath}/`)) {
    return path.slice(appBasePath.length) || '/'
  }

  return path
}

function normalizeBackendUrl(value: string): string {
  const url = new URL(value)
  const segments = url.pathname.split('/').filter(Boolean)
  const apiIndex = segments.indexOf('api')
  const backendSegments = apiIndex >= 0 ? segments.slice(0, apiIndex) : segments
  const backendPath = backendSegments.length > 0 ? `/${backendSegments.join('/')}` : ''
  return trimTrailingSlash(`${url.origin}${backendPath}`)
}

export function getRuntimeConfig(): RuntimeConfig {
  const overrides = runtimeOverrides()
  const appBasePath = normalizeBasePath(
    runtimeString(overrides, 'appBasePath') ||
      import.meta.env.VITE_APP_BASE_PATH ||
      import.meta.env.BASE_URL
  )
  const configuredBackendUrl =
    runtimeString(overrides, 'wegentBackendUrl') ||
    import.meta.env.VITE_WEGENT_BACKEND_URL?.trim() ||
    ''
  const wegentBackendUrl = configuredBackendUrl ? normalizeBackendUrl(configuredBackendUrl) : ''
  const apiBaseUrl =
    runtimeString(overrides, 'apiBaseUrl') ||
    (wegentBackendUrl ? `${wegentBackendUrl}/api` : joinAppPath(appBasePath, '/api'))
  const socketBaseUrl =
    runtimeString(overrides, 'socketBaseUrl') ||
    import.meta.env.VITE_WEGENT_SOCKET_URL?.trim() ||
    wegentBackendUrl ||
    window.location.origin
  const socketPath =
    runtimeString(overrides, 'socketPath') || joinAppPath(appBasePath, '/socket.io')

  return {
    appBasePath,
    apiBaseUrl: trimTrailingSlash(apiBaseUrl),
    socketBaseUrl: trimTrailingSlash(socketBaseUrl),
    socketPath,
    wegentBackendUrl,
    runtimeMode: resolveRuntimeMode(overrides),
    loginMode: resolveLoginMode(overrides),
    oidcLoginText:
      runtimeString(overrides, 'oidcLoginText') || import.meta.env.VITE_OIDC_LOGIN_TEXT || '',
    cloudDeviceScalingWikiUrl:
      runtimeString(overrides, 'cloudDeviceScalingWikiUrl') ||
      import.meta.env.VITE_CLOUD_DEVICE_SCALING_WIKI_URL ||
      '',
  }
}
