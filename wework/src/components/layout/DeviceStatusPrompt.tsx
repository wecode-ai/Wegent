import { AlertCircle, ArrowUpCircle, Loader2, PlusCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  presentation?: 'banner' | 'sidebar-action'
  hideAvailableUpdates?: boolean
  className?: string
}

const SIDEBAR_EMPTY_DEVICE_FALLBACK_MS = 30_000
const SIDEBAR_TOOLTIP_MAX_WIDTH = 288
const SIDEBAR_TOOLTIP_MARGIN = 8
const SIDEBAR_DEVICE_CACHE_KEY = 'wework.sidebar.lastNonEmptyDevices'

let sidebarDeviceMemoryCache: {
  devices: DeviceInfo[]
  updatedAt: number
} | null = null

function readSidebarDeviceCache() {
  if (sidebarDeviceMemoryCache) return sidebarDeviceMemoryCache

  try {
    const value = window.sessionStorage.getItem(SIDEBAR_DEVICE_CACHE_KEY)
    if (!value) return null
    const parsed = JSON.parse(value)
    if (
      !parsed ||
      !Array.isArray(parsed.devices) ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null
    }
    sidebarDeviceMemoryCache = parsed
    return parsed as { devices: DeviceInfo[]; updatedAt: number }
  } catch {
    return null
  }
}

function readFreshSidebarDeviceCache(maxAgeMs: number) {
  const cached = readSidebarDeviceCache()
  if (!cached) return null

  return Date.now() - cached.updatedAt < maxAgeMs ? cached : null
}

function writeSidebarDeviceCache(devices: DeviceInfo[], updatedAt: number) {
  sidebarDeviceMemoryCache = { devices, updatedAt }
  try {
    window.sessionStorage.setItem(
      SIDEBAR_DEVICE_CACHE_KEY,
      JSON.stringify(sidebarDeviceMemoryCache),
    )
  } catch {
    // Keep the in-memory cache when browser storage is unavailable.
  }
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
  presentation = 'banner',
  hideAvailableUpdates = false,
  className,
}: DeviceStatusPromptProps) {
  const { t } = useTranslation('common')
  const [manualPending, setManualPending] = useState(false)
  const [sidebarTooltipPosition, setSidebarTooltipPosition] = useState<{
    left: number
    top: number
    maxWidth: number
  } | null>(null)
  const [sidebarTooltipOpen, setSidebarTooltipOpen] = useState(false)
  const sidebarActionRef = useRef<HTMLDivElement>(null)
  const sidebarTooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (presentation === 'sidebar-action' && devices.length > 0) {
      writeSidebarDeviceCache(devices, Date.now())
    }
  }, [devices, presentation])

  const sidebarDeviceCache =
    presentation === 'sidebar-action'
      ? readFreshSidebarDeviceCache(SIDEBAR_EMPTY_DEVICE_FALLBACK_MS)
      : null
  const canUseSidebarDeviceFallback =
    presentation === 'sidebar-action' &&
    devices.length === 0 &&
    sidebarDeviceCache !== null
  const effectiveDevices = canUseSidebarDeviceFallback
    ? sidebarDeviceCache?.devices ?? devices
    : devices
  const claudeCodeDevices = useMemo(
    () => effectiveDevices.filter(isClaudeCodeDevice),
    [effectiveDevices],
  )
  const activeDevice = activeDeviceId
    ? claudeCodeDevices.find(device => device.device_id === activeDeviceId) ?? null
    : null
  const compatibleDevices = claudeCodeDevices.filter(isWeWorkCompatibleDevice)
  const outdatedDevices = claudeCodeDevices.filter(isDeviceBelowWeWorkVersion)
  const updateCandidates = claudeCodeDevices.filter(
    device => device.status !== 'offline' && hasWeWorkUpdateAvailable(device),
  )
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

  const updateSidebarTooltipPosition = () => {
    const rect = sidebarActionRef.current?.getBoundingClientRect()
    if (!rect) return

    const viewportMaxWidth = Math.max(
      0,
      window.innerWidth - SIDEBAR_TOOLTIP_MARGIN * 2,
    )
    const maxWidth = Math.min(SIDEBAR_TOOLTIP_MAX_WIDTH, viewportMaxWidth)
    const measuredWidth = sidebarTooltipRef.current?.offsetWidth ?? 0
    const tooltipWidth = measuredWidth > 0 ? measuredWidth : maxWidth
    const maxLeft = Math.max(
      SIDEBAR_TOOLTIP_MARGIN,
      window.innerWidth - tooltipWidth - SIDEBAR_TOOLTIP_MARGIN,
    )

    setSidebarTooltipPosition({
      left: Math.max(SIDEBAR_TOOLTIP_MARGIN, Math.min(rect.left, maxLeft)),
      top: rect.bottom + SIDEBAR_TOOLTIP_MARGIN,
      maxWidth,
    })
  }

  const openSidebarTooltip = () => {
    updateSidebarTooltipPosition()
    setSidebarTooltipOpen(true)
    window.requestAnimationFrame(updateSidebarTooltipPosition)
  }

  const closeSidebarTooltip = () => {
    setSidebarTooltipOpen(false)
  }

  const renderSidebarAction = ({
    message,
    actionLabel,
    deviceIds,
    tone,
    loading = false,
  }: {
    message: string
    actionLabel: string
    deviceIds: string[]
    tone: 'primary' | 'danger'
    loading?: boolean
  }) => {
    const toneClass = tone === 'danger'
      ? 'bg-red-50 text-red-600 hover:bg-red-100 disabled:hover:bg-red-50'
      : 'bg-blue-50 text-blue-600 hover:bg-blue-100 disabled:hover:bg-blue-50'
    const tooltip = (
      <div
        ref={sidebarTooltipRef}
        data-testid="device-status-sidebar-tooltip"
        style={
          sidebarTooltipPosition
            ? {
                left: sidebarTooltipPosition.left,
                top: sidebarTooltipPosition.top,
                maxWidth: sidebarTooltipPosition.maxWidth,
              }
            : undefined
        }
        className={cn(
          'pointer-events-none fixed z-system-popover w-max min-w-0 whitespace-normal break-words rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-text-primary shadow-[0_16px_44px_rgba(0,0,0,0.16)] ring-1 ring-black/5',
          sidebarTooltipOpen ? 'block' : 'hidden',
        )}
      >
        {message}
      </div>
    )

    return (
      <>
        <div
          ref={sidebarActionRef}
          data-testid="device-status-prompt"
          className={cn('relative shrink-0', className)}
          onMouseEnter={openSidebarTooltip}
          onMouseMove={updateSidebarTooltipPosition}
          onMouseLeave={closeSidebarTooltip}
          onFocusCapture={openSidebarTooltip}
          onBlurCapture={closeSidebarTooltip}
        >
          <button
            type="button"
            data-testid="device-status-sidebar-action-button"
            disabled={manualPending || loading || deviceIds.length === 0}
            onClick={() => void runUpgrades(deviceIds)}
            aria-label={message}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
              toneClass,
            )}
          >
            {manualPending || loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            <span>{actionLabel}</span>
          </button>
        </div>
        {typeof document === 'undefined' ? (
          tooltip
        ) : (
          createPortal(tooltip, document.body)
          )}
      </>
    )
  }

  if (claudeCodeDevices.length === 0) {
    if (presentation === 'sidebar-action') return null

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
    const message = t('workbench.device_status_upgrading', {
      device: getDeviceName(activeUpgradeDevice),
      message: upgradeState?.message ?? t('workbench.device_status_checking'),
    })
    if (presentation === 'sidebar-action') {
      return renderSidebarAction({
        message,
        actionLabel: t('workbench.device_status_upgrade_action'),
        deviceIds: [],
        tone: 'primary',
        loading: true,
      })
    }

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
          {message}
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
    const message = canUpgrade
      ? t('workbench.device_status_active_upgrade_required', {
          device: getDeviceName(activeDevice),
          version: WEWORK_MIN_EXECUTOR_VERSION,
        })
      : t('workbench.device_status_active_upgrade_waiting', {
          device: getDeviceName(activeDevice),
          reason: getBlockedReason(activeDevice, t),
          version: WEWORK_MIN_EXECUTOR_VERSION,
        })

    if (presentation === 'sidebar-action') {
      if (!canUpgrade) return null

      return renderSidebarAction({
        message,
        actionLabel: t('workbench.device_status_upgrade_action'),
        deviceIds: upgradeDeviceIds,
        tone: 'danger',
      })
    }

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
          {message}
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
    if (presentation === 'sidebar-action') return null

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
    const message = blockedDevice && upgradeDeviceIds.length === 0
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
          })

    if (presentation === 'sidebar-action') {
      if (upgradeDeviceIds.length === 0) return null

      return renderSidebarAction({
        message,
        actionLabel: t('workbench.device_status_upgrade_action'),
        deviceIds: upgradeDeviceIds,
        tone: 'danger',
      })
    }

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
          {message}
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
    if (presentation === 'sidebar-action') return null

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
    if (hideAvailableUpdates) return null

    const upgradeDeviceIds = updateCandidates
      .filter(canRequestDeviceUpgrade)
      .map(device => device.device_id)
    const message = t('workbench.device_status_update_available', {
      count: updateCandidates.length,
    })

    if (presentation === 'sidebar-action') {
      return renderSidebarAction({
        message,
        actionLabel: t('workbench.device_status_update_action'),
        deviceIds: upgradeDeviceIds,
        tone: 'primary',
      })
    }

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
