import { AlertCircle, ArrowUpCircle, Loader2, PlusCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canRequestDeviceUpgrade,
  hasWeWorkUpdateAvailable,
  isClaudeCodeDevice,
  isDeviceBelowWeWorkVersion,
  isDeviceRunningTask,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import { cn } from '@/lib/utils'
import type { DeviceInfo } from '@/types/api'
import type { DeviceUpgradeState } from '@/types/device-events'

interface DeviceStatusPromptProps {
  devices: DeviceInfo[]
  upgradingDevices: Record<string, DeviceUpgradeState>
  onUpgradeDevice: (deviceId: string) => Promise<void>
  onOpenCloudDeviceSettings: () => void
  activeDeviceId?: string | null
  requiresOnlineCompatibleDevice?: boolean
  compact?: boolean
  className?: string
}

function getDeviceName(device: DeviceInfo): string {
  return device.name || device.device_id
}

function getBlockedReason(device: DeviceInfo, t: ReturnType<typeof useTranslation>['t']): string {
  if (device.status !== 'online') {
    return t('workbench.device_status_offline_reason')
  }
  if (isDeviceRunningTask(device)) {
    return t('workbench.device_status_busy_reason')
  }
  return t('workbench.device_status_unavailable_reason')
}

function isUpgradeActive(upgradeState: DeviceUpgradeState | undefined): boolean {
  return Boolean(
    upgradeState &&
      !['success', 'error', 'skipped', 'busy'].includes(upgradeState.status),
  )
}

export function DeviceStatusPrompt({
  devices,
  upgradingDevices,
  onUpgradeDevice,
  onOpenCloudDeviceSettings,
  activeDeviceId,
  requiresOnlineCompatibleDevice = false,
  compact = false,
  className,
}: DeviceStatusPromptProps) {
  const { t } = useTranslation('common')
  const [manualPending, setManualPending] = useState(false)
  const claudeCodeDevices = useMemo(
    () => devices.filter(isClaudeCodeDevice),
    [devices],
  )
  const activeDevice = activeDeviceId
    ? claudeCodeDevices.find(device => device.device_id === activeDeviceId) ?? null
    : null
  const compatibleDevices = claudeCodeDevices.filter(isWeWorkCompatibleDevice)
  const outdatedDevices = claudeCodeDevices.filter(isDeviceBelowWeWorkVersion)
  const updateCandidates = compatibleDevices.filter(hasWeWorkUpdateAvailable)
  const activeUpgradeDevice = (() => {
    if (activeDevice && isUpgradeActive(upgradingDevices[activeDevice.device_id])) {
      return activeDevice
    }
    if (compatibleDevices.length === 0) {
      return claudeCodeDevices.find(device =>
        isUpgradeActive(upgradingDevices[device.device_id])
      )
    }
    return updateCandidates.find(device =>
      isUpgradeActive(upgradingDevices[device.device_id])
    )
  })()
  const lowVersionUpgradeCandidates = outdatedDevices.filter(canRequestDeviceUpgrade)
  const lowVersionBlockedDevices = outdatedDevices.filter(
    device => !canRequestDeviceUpgrade(device),
  )

  const runUpgrades = async (deviceIds: string[]) => {
    if (deviceIds.length === 0) return
    setManualPending(true)
    try {
      await Promise.all(deviceIds.map(deviceId => onUpgradeDevice(deviceId)))
    } finally {
      setManualPending(false)
    }
  }

  if (claudeCodeDevices.length === 0) {
    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary',
          compact && 'mx-0',
          className,
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          {t('workbench.device_status_no_devices')}
        </span>
        <button
          type="button"
          data-testid="device-status-create-device-button"
          onClick={onOpenCloudDeviceSettings}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-primary hover:bg-primary/10"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          {t('workbench.device_status_create_device')}
        </button>
      </div>
    )
  }

  if (activeUpgradeDevice) {
    const upgradeState = upgradingDevices[activeUpgradeDevice.device_id]
    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-text-secondary',
          compact && 'mx-0',
          className,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate">
          {t('workbench.device_status_upgrading', {
            device: getDeviceName(activeUpgradeDevice),
            message: upgradeState?.message ?? t('workbench.device_status_checking'),
          })}
        </span>
        {typeof upgradeState?.progress === 'number' && (
          <span className="shrink-0 tabular-nums text-text-muted">
            {Math.round(upgradeState.progress)}%
          </span>
        )}
      </div>
    )
  }

  if (activeDevice && isDeviceBelowWeWorkVersion(activeDevice)) {
    const canUpgrade = canRequestDeviceUpgrade(activeDevice)
    const upgradeDeviceIds = canUpgrade ? [activeDevice.device_id] : []

    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900',
          compact && 'mx-0',
          className,
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1">
          {canUpgrade
            ? t('workbench.device_status_active_upgrade_required', {
                device: getDeviceName(activeDevice),
                version: WEWORK_MIN_EXECUTOR_VERSION,
              })
            : t('workbench.device_status_active_upgrade_waiting', {
                device: getDeviceName(activeDevice),
                reason: getBlockedReason(activeDevice, t),
                version: WEWORK_MIN_EXECUTOR_VERSION,
              })}
        </span>
        {upgradeDeviceIds.length > 0 && (
          <button
            type="button"
            data-testid="device-status-upgrade-button"
            disabled={manualPending}
            onClick={() => void runUpgrades(upgradeDeviceIds)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {manualPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            {t('workbench.device_status_upgrade_action')}
          </button>
        )}
      </div>
    )
  }

  if (activeDevice && activeDevice.status !== 'online') {
    const messageKey = isDeviceRunningTask(activeDevice) || activeDevice.status === 'busy'
      ? 'workbench.device_status_active_busy'
      : activeDevice.status === 'offline'
        ? 'workbench.device_status_active_offline'
        : 'workbench.device_status_active_unavailable'

    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary',
          compact && 'mx-0',
          className,
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          {t(messageKey, { device: getDeviceName(activeDevice) })}
        </span>
      </div>
    )
  }

  if (compatibleDevices.length === 0 && outdatedDevices.length > 0) {
    const upgradeDevices = lowVersionUpgradeCandidates
    const upgradeDeviceIds = upgradeDevices.map(device => device.device_id)
    const blockedDevice = lowVersionBlockedDevices[0]
    const upgradeDevice = upgradeDevices[0]
    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900',
          compact && 'mx-0',
          className,
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <span className="min-w-0 flex-1">
          {blockedDevice && upgradeDeviceIds.length === 0
            ? t('workbench.device_status_upgrade_waiting', {
                device: getDeviceName(blockedDevice),
                reason: getBlockedReason(blockedDevice, t),
                version: WEWORK_MIN_EXECUTOR_VERSION,
              })
            : upgradeDevices.length === 1 && upgradeDevice
              ? t('workbench.device_status_upgrade_required_device', {
                  device: getDeviceName(upgradeDevice),
                  version: WEWORK_MIN_EXECUTOR_VERSION,
                })
              : t('workbench.device_status_upgrade_required_devices', {
                  count: upgradeDevices.length,
                  version: WEWORK_MIN_EXECUTOR_VERSION,
                })}
        </span>
        {upgradeDeviceIds.length > 0 && (
          <button
            type="button"
            data-testid="device-status-upgrade-button"
            disabled={manualPending}
            onClick={() => void runUpgrades(upgradeDeviceIds)}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {manualPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            {upgradeDevices.length === 1
              ? t('workbench.device_status_upgrade_single_action')
              : t('workbench.device_status_upgrade_devices_action', {
                  count: upgradeDevices.length,
                })}
          </button>
        )}
      </div>
    )
  }

  if (
    requiresOnlineCompatibleDevice &&
    compatibleDevices.length > 0 &&
    !compatibleDevices.some(device => device.status === 'online')
  ) {
    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary',
          compact && 'mx-0',
          className,
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          {t('workbench.device_status_no_online_device')}
        </span>
      </div>
    )
  }

  if (updateCandidates.length > 0) {
    const upgradeDeviceIds = updateCandidates
      .filter(canRequestDeviceUpgrade)
      .map(device => device.device_id)
    if (upgradeDeviceIds.length === 0) return null

    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary',
          compact && 'mx-0',
          className,
        )}
      >
        <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          {t('workbench.device_status_update_available', {
            count: updateCandidates.length,
          })}
        </span>
        <button
          type="button"
          data-testid="device-status-update-button"
          disabled={manualPending}
          onClick={() => void runUpgrades(upgradeDeviceIds)}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {manualPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3.5 w-3.5" />
          )}
          {t('workbench.device_status_update_action')}
        </button>
      </div>
    )
  }

  return null
}
