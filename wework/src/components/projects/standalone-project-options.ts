import {
  canUseForProjectCreation,
  canUseForRemoteProjectCreation,
  hasLocalRuntimeRoute,
  isClaudeCodeDevice,
  isCloudDevice,
  isRemoteDevice,
  isUsableDevice,
  isWeWorkExecutorVersionCompatible,
} from '@/lib/device-capabilities'
import type { DeviceInfo } from '@/types/api'
import type { DockerRemoteDeviceCommandResponse, RemoteDeviceStartupCommand } from '@/types/devices'

export type StandaloneWorkspaceDialogMode = 'existing' | 'remote'

export function isLocalDevice(device: DeviceInfo): boolean {
  return !isCloudDevice(device) && !isRemoteDevice(device)
}

export function isRemoteProjectDevice(device: DeviceInfo): boolean {
  return isCloudDevice(device) || isRemoteDevice(device)
}

export function getRemoteDeviceLabel(device: DeviceInfo): string {
  return device.name?.trim() || ''
}

function extractNetworkHost(value?: string | null): string | null {
  if (!value?.trim()) return null
  const trimmedValue = value.trim()
  const bracketMatch = trimmedValue.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]
  const colonParts = trimmedValue.split(':')
  return colonParts.length === 2 && /^\d+$/.test(colonParts[1]) ? colonParts[0] : trimmedValue
}

export function getRemoteDeviceOptionLabel(
  device: DeviceInfo,
  typeLabel: string,
  unavailableLabel: string,
  upgradeLabel: string
): string {
  const deviceLabel = getRemoteDeviceLabel(device)
  const networkLabel =
    extractNetworkHost(device.runtime_transfer_host) ?? extractNetworkHost(device.client_ip)
  const labels = [typeLabel, deviceLabel]
  if (networkLabel && networkLabel !== deviceLabel) labels.push(networkLabel)
  if (!isUsableDevice(device)) labels.push(unavailableLabel)
  else if (!isWeWorkExecutorVersionCompatible(device.executor_version)) labels.push(upgradeLabel)
  return labels.join(' · ')
}

export function getStandaloneDeviceOptions(
  devices: DeviceInfo[],
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo[] {
  const isTargetDevice = mode === 'remote' ? isRemoteProjectDevice : isLocalDevice
  return devices.filter(
    device =>
      isClaudeCodeDevice(device) &&
      isTargetDevice(device) &&
      (mode !== 'remote' || !hasLocalRuntimeRoute(device))
  )
}

export function getUsableStandaloneDevices(
  devices: DeviceInfo[],
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo[] {
  return getStandaloneDeviceOptions(devices, mode)
    .filter(device =>
      mode === 'remote' ? canUseForRemoteProjectCreation(device) : canUseForProjectCreation(device)
    )
    .sort((left, right) => getRemoteDeviceLabel(left).localeCompare(getRemoteDeviceLabel(right)))
}

export function getPreferredStandaloneWorkspaceDevice(
  devices: DeviceInfo[],
  preferredDeviceId: string | null | undefined,
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo | null {
  const usableDevices = getUsableStandaloneDevices(devices, mode)
  return (
    usableDevices.find(device => device.device_id === preferredDeviceId) ??
    usableDevices.find(device => device.is_default) ??
    usableDevices[0] ??
    null
  )
}

export function getUniqueProjectDirectoryName(baseName: string, existingNames: string[]): string {
  const existingNameSet = new Set(existingNames.map(name => name.trim()).filter(Boolean))
  if (!existingNameSet.has(baseName)) return baseName
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`
    if (!existingNameSet.has(candidate)) return candidate
  }
  return `${baseName} ${Date.now()}`
}

export function normalizeRemoteDeviceStartupCommands(
  response: DockerRemoteDeviceCommandResponse | null
): RemoteDeviceStartupCommand[] {
  if (!response) return []
  if (Array.isArray(response.commands) && response.commands.length > 0) {
    return response.commands.filter(command => command.command.trim())
  }
  return [{ kind: 'docker', label: 'Docker', command: response.command }]
}
