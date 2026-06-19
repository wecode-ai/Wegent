export interface RuntimeConfig {
  appBasePath: string
  apiBaseUrl: string
  socketBaseUrl: string
  socketPath: string
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
  key: keyof RuntimeConfig,
): string | undefined {
  const value = overrides[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
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

export function getRuntimeConfig(): RuntimeConfig {
  const overrides = runtimeOverrides()
  const appBasePath = normalizeBasePath(
    runtimeString(overrides, 'appBasePath') ||
      import.meta.env.VITE_APP_BASE_PATH ||
      import.meta.env.BASE_URL,
  )
  const apiBaseUrl =
    runtimeString(overrides, 'apiBaseUrl') ||
    import.meta.env.VITE_API_BASE_URL ||
    joinAppPath(appBasePath, '/api')
  const socketBaseUrl =
    runtimeString(overrides, 'socketBaseUrl') ||
    import.meta.env.VITE_SOCKET_BASE_URL ||
    window.location.origin
  const socketPath =
    runtimeString(overrides, 'socketPath') ||
    import.meta.env.VITE_SOCKET_PATH ||
    joinAppPath(appBasePath, '/socket.io')

  return {
    appBasePath,
    apiBaseUrl: trimTrailingSlash(apiBaseUrl),
    socketBaseUrl: trimTrailingSlash(socketBaseUrl),
    socketPath,
    loginMode:
      (runtimeString(overrides, 'loginMode') as RuntimeConfig['loginMode'] | undefined) ||
      (import.meta.env.VITE_LOGIN_MODE as RuntimeConfig['loginMode'] | undefined) ||
      'all',
    oidcLoginText:
      runtimeString(overrides, 'oidcLoginText') || import.meta.env.VITE_OIDC_LOGIN_TEXT || '',
    cloudDeviceScalingWikiUrl:
      runtimeString(overrides, 'cloudDeviceScalingWikiUrl') ||
      import.meta.env.VITE_CLOUD_DEVICE_SCALING_WIKI_URL ||
      '',
  }
}
