import { supportsConnectionEvents } from '@/lib/device-capabilities'
import { outputAsRecord, type DeviceCommandApi } from './environment'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'

/** Cancellation uses the owned device transport and never starts a model turn. */
export async function cancelConnectionEventSubscription(
  api: DeviceCommandApi,
  address: RuntimeTaskAddress,
  subscriptionKey: string,
  device: Pick<DeviceInfo, 'runtime_features'> | null | undefined
): Promise<void> {
  if (!supportsConnectionEvents(device)) {
    throw Object.assign(new Error('The device has not advertised event subscription support'), {
      code: 'connection_event_upgrade_required',
    })
  }
  const response = await api.executeCommand(address.deviceId, {
    command_key: 'connection_subscription_cancel',
    args: [address.taskId, subscriptionKey],
  })
  const record = outputAsRecord(response.stdout)?.subscription
  if (
    !response.success ||
    !record ||
    typeof record !== 'object' ||
    (record as Record<string, unknown>).subscription_key !== subscriptionKey ||
    (record as Record<string, unknown>).status !== 'cancelled'
  ) {
    throw new Error(response.error || response.stderr || 'Event cancellation was not confirmed')
  }
}
