import type { DeviceInfo } from '@/types/api'
import {
  canUseForProjectCreation,
  canUseForRemoteProjectCreation,
  hasLocalRuntimeRoute,
  isCloudDevice,
  isRemoteDevice,
  isClaudeCodeDevice,
  isUsableDevice,
  isWeWorkExecutorVersionCompatible,
} from '@/lib/device-capabilities'
import type { StandaloneWorkspaceDialogMode } from './StandaloneProjectDialogs'

export function isLocalDevice(device: DeviceInfo): boolean {
  return !isCloudDevice(device) && !isRemoteDevice(device)
}

export function isRemoteProjectDevice(device: DeviceInfo): boolean {
  return isCloudDevice(device) || isRemoteDevice(device)
}

function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name?.trim() || ''
}

function extractNetworkHost(value?: string | null): string | null {
  if (!value) return null
  const trimmedValue = value.trim()
  if (!trimmedValue) return null

  const bracketMatch = trimmedValue.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]

  const colonParts = trimmedValue.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }

  return trimmedValue
}

function getRemoteDeviceNetworkLabel(device: DeviceInfo): string | null {
  return extractNetworkHost(device.runtime_transfer_host) ?? extractNetworkHost(device.client_ip)
}

export function getRemoteDeviceLabel(device: DeviceInfo): string {
  return getStandaloneDeviceLabel(device)
}

export function getRemoteDeviceOptionLabel(
  device: DeviceInfo,
  typeLabel: string,
  unavailableLabel: string,
  upgradeLabel: string
): string {
  const deviceLabel = getStandaloneDeviceLabel(device)
  const networkLabel = getRemoteDeviceNetworkLabel(device)
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
    .sort((left, right) => {
      const leftLabel = isRemoteProjectDevice(left)
        ? getRemoteDeviceLabel(left)
        : getStandaloneDeviceLabel(left)
      const rightLabel = isRemoteProjectDevice(right)
        ? getRemoteDeviceLabel(right)
        : getStandaloneDeviceLabel(right)
      return leftLabel.localeCompare(rightLabel)
    })
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
