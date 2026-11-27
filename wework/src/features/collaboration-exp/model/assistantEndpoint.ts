import {
  cloudDeviceEndpoint,
  localWeworkEndpoint,
  type AssistantEndpointInput,
} from '@wegent/collaboration'
import type { DeviceInfo } from '@/types/api'
import { findWorkbenchDevice } from '@/lib/workbench-device'

/** Keep the provider identity aligned with the assistant's configured device. */
export function experienceAssistantEndpoint(
  devices: readonly DeviceInfo[] | null | undefined,
  deviceId: string | undefined,
  input: Omit<AssistantEndpointInput, 'kind' | 'availability'> & {
    availability?: AssistantEndpointInput['availability']
  }
) {
  const device = findWorkbenchDevice((devices ?? []) as DeviceInfo[], deviceId)
  if (!device) return null
  const availability =
    input.availability ??
    (device.status === 'online' || device.status === 'busy' ? 'online' : 'offline')
  const scoped = { ...input, availability }
  return device.device_type === 'cloud' || device.device_type === 'remote'
    ? cloudDeviceEndpoint(scoped)
    : localWeworkEndpoint(scoped)
}
