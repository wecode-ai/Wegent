import type { WeworkDestination } from '@wegent/chat-core'

export { parseWeworkScheme, type WeworkDestination } from '@wegent/chat-core'

export function weworkDestinationRoute(destination: WeworkDestination): string {
  if (destination.kind === 'boards') return '/todo'
  if (destination.kind === 'task') {
    return `/runtime-tasks?${new URLSearchParams({ deviceId: destination.deviceId, taskId: destination.taskId })}`
  }
  const params = new URLSearchParams({ projectStore: 'backend', projectId: destination.projectId })
  if (destination.itemId) params.set('itemId', destination.itemId)
  return `/todo?${params}`
}
