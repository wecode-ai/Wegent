export interface TrayTaskMenuAddress {
  deviceId: string
  taskId: string
}

export function createTrayTaskMenuId(address: TrayTaskMenuAddress): string {
  return `${encodeURIComponent(address.deviceId)}:${encodeURIComponent(String(address.taskId))}`
}

export function parseTrayTaskMenuId(id: string): TrayTaskMenuAddress | null {
  const parts = id.split(':')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  try {
    const taskId = decodeURIComponent(parts[1]).trim()
    if (!taskId) return null
    return {
      deviceId: decodeURIComponent(parts[0]),
      taskId,
    }
  } catch {
    return null
  }
}
