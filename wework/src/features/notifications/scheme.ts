export type WeworkDestination =
  | { kind: 'boards' }
  | { kind: 'board'; projectId: string; itemId?: string; assignmentId?: string }
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
      input.includes('?') ||
      input.includes('#') ||
      Array.from(input).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
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
    if (url.hostname === 'boards' && ['', '/'].includes(url.pathname)) return { kind: 'boards' }
    const parts = url.pathname.split('/').slice(1)
    if (url.hostname === 'boards' && [1, 3, 5].includes(parts.length)) {
      const projectId = segment(parts[0])
      if (!projectId || !/^[1-9]\d*$/.test(projectId)) return null
      if (parts.length === 1) return { kind: 'board', projectId }
      const itemId = segment(parts[2])
      if (parts.length === 5) {
        const assignmentId = segment(parts[4])
        return parts[1] === 'issues' && itemId && parts[3] === 'assignments' && assignmentId
          ? { kind: 'board', projectId, itemId, assignmentId }
          : null
      }
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
  if (destination.kind === 'boards') return '/todo'
  if (destination.kind === 'task') {
    return `/runtime-tasks?${new URLSearchParams({ deviceId: destination.deviceId, taskId: destination.taskId })}`
  }
  const params = new URLSearchParams({ projectStore: 'backend', projectId: destination.projectId })
  if (destination.itemId) params.set('itemId', destination.itemId)
  if (destination.assignmentId) params.set('assignmentId', destination.assignmentId)
  return `/todo?${params}`
}
