const UNSUPPORTED_STAND_IN_RPC = /Unsupported runtime RPC method: runtime\.stand_in\./

interface StandInDevice {
  device_id: string
  app_device_id?: string | null
  name: string
}

export function standInDeviceLabel(
  devices: readonly StandInDevice[],
  deviceId: string | undefined
) {
  if (!deviceId) return ''
  const device = devices.find(row => row.device_id === deviceId || row.app_device_id === deviceId)
  return device?.name || deviceId
}

export function standInErrorMessage(
  message: string,
  device: string,
  translate: (key: 'standIn.executor_update_required', options: { device: string }) => string
) {
  return UNSUPPORTED_STAND_IN_RPC.test(message)
    ? translate('standIn.executor_update_required', { device })
    : message
}
