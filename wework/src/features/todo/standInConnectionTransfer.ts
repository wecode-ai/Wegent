import type { StandInSourceConnection } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'

export function transferredConnection(
  connection: StandInSourceConnection
): StandInSourceConnection {
  const settings = { ...connection }
  delete settings.boundary
  delete settings.pendingTakeover
  delete settings.resumePending
  if (settings.subscriptionId && settings.generation && settings.transport !== 'cli') {
    return { ...settings, pendingTakeover: true, resumePending: true }
  }
  return settings
}

export async function checkTargetConnectionProviders(
  api: StandInExecutorApi,
  deviceId: string,
  connections?: StandInSourceConnection[]
) {
  if (!connections?.length) return
  const { items } = await api.connectionProviders(deviceId)
  const providers = new Map(items.map(provider => [provider.id, provider]))
  for (const { providerId } of connections) {
    if (providers.get(providerId)?.availability.status !== 'ready') {
      throw Object.assign(new Error('Connect this provider on the destination device'), {
        code: 'stand_in_target_connection_unavailable',
      })
    }
  }
}
