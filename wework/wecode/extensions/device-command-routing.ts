const CLOUD_DEVICE_COMMANDS = new Set(['vnc_clipboard_read', 'vnc_clipboard_write'])

export function shouldUseCloudDeviceCommand(commandKey: string): boolean {
  return CLOUD_DEVICE_COMMANDS.has(commandKey)
}
