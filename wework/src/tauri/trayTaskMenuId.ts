export interface TrayTaskMenuAddress {
  deviceId: string
  localTaskId: string
}

export function createTrayTaskMenuId(address: TrayTaskMenuAddress): string {
  return `${encodeURIComponent(address.deviceId)}:${encodeURIComponent(address.localTaskId)}`
}

export function parseTrayTaskMenuId(id: string): TrayTaskMenuAddress | null {
  const parts = id.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  try {
    return {
      deviceId: decodeURIComponent(parts[0]),
      localTaskId: decodeURIComponent(parts[1]),
    }
  } catch {
    return null
  }
}
