/**
 * Wecode device command routing policy.
 *
 * Return `true` for a command key that the cloud backend must execute over
 * HTTP instead of the local Electron bridge. The Wecode distribution owns this
 * policy but currently has no cloud-only device command, so every command keeps
 * going through the bridge.
 */
export const shouldUseCloudDeviceCommand: (commandKey: string) => boolean = () => false
