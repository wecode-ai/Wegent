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

function firstStringValue(...values: Array<string | undefined>): string | undefined {
  return values.find(value => typeof value === 'string' && value.length > 0)
}

function hasOwnRuntimeValue(
  runtimeConfig: RuntimeConfigOverrides,
  key: keyof RuntimeConfigOverrides
): boolean {
  return Object.prototype.hasOwnProperty.call(runtimeConfig, key)
}

function getRuntimeOrBuildValue(
  runtimeConfig: RuntimeConfigOverrides,
  key: keyof RuntimeConfigOverrides,
  buildValue: string | undefined,
  fallback: string
): string {
  if (hasOwnRuntimeValue(runtimeConfig, key)) {
    return firstStringValue(runtimeConfig[key], fallback) || fallback
  }

  return firstStringValue(buildValue, fallback) || fallback
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
  const runtimeConfig = window.__WEWORK_RUNTIME_CONFIG__ || {}
  const appBasePath = normalizeBasePath(
    getRuntimeOrBuildValue(
      runtimeConfig,
      'appBasePath',
      import.meta.env.VITE_APP_BASE_PATH,
      import.meta.env.BASE_URL || '',
    ),
  )
  const apiBaseUrl = getRuntimeOrBuildValue(
    runtimeConfig,
    'apiBaseUrl',
    import.meta.env.VITE_API_BASE_URL,
    joinAppPath(appBasePath, '/api'),
  )
  const socketBaseUrl = getRuntimeOrBuildValue(
    runtimeConfig,
    'socketBaseUrl',
    import.meta.env.VITE_SOCKET_BASE_URL,
    window.location.origin,
  )
  const socketPath = getRuntimeOrBuildValue(
    runtimeConfig,
    'socketPath',
    import.meta.env.VITE_SOCKET_PATH,
    joinAppPath(appBasePath, '/socket.io'),
  )
  const loginMode =
    getRuntimeOrBuildValue(
      runtimeConfig,
      'loginMode',
      import.meta.env.VITE_LOGIN_MODE,
      'all',
    ) as RuntimeConfig['loginMode']

  return {
    appBasePath,
    apiBaseUrl: trimTrailingSlash(apiBaseUrl),
    socketBaseUrl: trimTrailingSlash(socketBaseUrl),
    socketPath,
    loginMode,
    oidcLoginText: getRuntimeOrBuildValue(
      runtimeConfig,
      'oidcLoginText',
      import.meta.env.VITE_OIDC_LOGIN_TEXT,
      '',
    ),
    cloudDeviceScalingWikiUrl: getRuntimeOrBuildValue(
      runtimeConfig,
      'cloudDeviceScalingWikiUrl',
      import.meta.env.VITE_CLOUD_DEVICE_SCALING_WIKI_URL,
      '',
    ),
  }
}
