export const DEVICE_DESKTOP_PATH = '/device-desktop'

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
