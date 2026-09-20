export const DEVICE_DESKTOP_PATH = '/device-desktop'
export const DEVICE_DESKTOP_SURFACE_PARAMETER = 'vncSurface'
export const DEVICE_DESKTOP_SURFACE_VALUE = 'isolated'

export function deviceDesktopRoute(deviceId: string): string {
  const params = new URLSearchParams()
  params.set('deviceId', deviceId)
  return `${DEVICE_DESKTOP_PATH}?${params.toString()}`
}

export function isDeviceDesktopInternalPageUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin)
    return url.pathname === DEVICE_DESKTOP_PATH
  } catch {
    return false
  }
}

export function isolatedDeviceDesktopUrl(
  deviceId: string,
  currentLocation = window.location.href
): string {
  const url = new URL(currentLocation)
  if (!url.pathname.endsWith(DEVICE_DESKTOP_PATH)) url.pathname = DEVICE_DESKTOP_PATH
  url.search = ''
  url.searchParams.set('deviceId', deviceId)
  url.searchParams.set(DEVICE_DESKTOP_SURFACE_PARAMETER, DEVICE_DESKTOP_SURFACE_VALUE)
  return url.toString()
}

export function isIsolatedDeviceDesktopSurface(search: string): boolean {
  const params = new URLSearchParams(search.replace(/^\?/, ''))
  return params.get(DEVICE_DESKTOP_SURFACE_PARAMETER) === DEVICE_DESKTOP_SURFACE_VALUE
}
