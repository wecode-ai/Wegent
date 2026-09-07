export type WeworkDestination =
  | { kind: 'board'; projectId: string; itemId?: string }
  | { kind: 'task'; deviceId: string; taskId: string }

function segment(value: string): string | null {
  const decoded = decodeURIComponent(value)
  return decoded &&
    decoded.length <= 128 &&
    !Array.from(decoded).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ? decoded
    : null
}

export function parseWeworkScheme(input: string): WeworkDestination | null {
  try {
    if (
      input !== input.trim() ||
      input.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))
    )
      return null
    const url = new URL(input)
    if (
      url.protocol !== 'wework:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null
    const parts = url.pathname.split('/').slice(1)
    if (url.hostname === 'boards' && (parts.length === 1 || parts.length === 3)) {
      const projectId = segment(parts[0])
      if (!projectId || !/^[1-9]\d*$/.test(projectId)) return null
      if (parts.length === 1) return { kind: 'board', projectId }
      const itemId = segment(parts[2])
      return parts[1] === 'issues' && itemId ? { kind: 'board', projectId, itemId } : null
    }
    if (url.hostname === 'tasks' && parts.length === 2) {
      const deviceId = segment(parts[0])
      const taskId = segment(parts[1])
      return deviceId && taskId ? { kind: 'task', deviceId, taskId } : null
    }
    return null
  } catch {
    return null
  }
}

export function weworkDestinationRoute(destination: WeworkDestination): string {
  if (destination.kind === 'task') {
    return `/runtime-tasks?${new URLSearchParams({ deviceId: destination.deviceId, taskId: destination.taskId })}`
  }
  const params = new URLSearchParams({ projectStore: 'backend', projectId: destination.projectId })
  if (destination.itemId) params.set('itemId', destination.itemId)
  return `/todo?${params}`
}
