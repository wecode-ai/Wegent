export interface RuntimeConfig {
  apiBaseUrl: string
  socketBaseUrl: string
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function getRuntimeConfig(): RuntimeConfig {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  const socketBaseUrl =
    import.meta.env.VITE_SOCKET_BASE_URL || window.location.origin

  return {
    apiBaseUrl: trimTrailingSlash(apiBaseUrl),
    socketBaseUrl: trimTrailingSlash(socketBaseUrl),
  }
}
