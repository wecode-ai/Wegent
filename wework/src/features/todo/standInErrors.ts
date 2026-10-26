import { findWorkbenchDevice, getWorkbenchDeviceDisplayName } from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'

const UNSUPPORTED_STAND_IN_RPC = /Unsupported runtime RPC method: runtime\.stand_in\./

export function standInDeviceLabel(devices: DeviceInfo[], deviceId: string | null | undefined) {
  return getWorkbenchDeviceDisplayName(findWorkbenchDevice(devices, deviceId), deviceId)
}

/**
 * Explains the raw hybrid-runtime failure raised by an Executor that predates the
 * `runtime.stand_in.*` API. Every other failure already carries user-facing text
 * and must stay untouched.
 */
export function standInErrorMessage(
  message: string,
  device: string,
  translate: (key: 'standIn.executor_update_required', options: { device: string }) => string
) {
  return UNSUPPORTED_STAND_IN_RPC.test(message)
    ? translate('standIn.executor_update_required', { device })
    : message
}
