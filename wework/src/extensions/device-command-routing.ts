export function shouldUseCloudDeviceCommand(commandKey: string): boolean {
  // The device command API maps this operation to the owned subscription RPC.
  return commandKey === 'connection_subscription_cancel'
}
