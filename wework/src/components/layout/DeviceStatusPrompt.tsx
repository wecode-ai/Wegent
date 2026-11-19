import { AlertCircle, ArrowUpCircle, Loader2, PlusCircle, RotateCcw } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useSidebarDeviceObservation } from './sidebarDeviceObservation'
import { createPortal } from 'react-dom'
import { CloudDeviceRestartProgress } from '@/features/cloud-devices/WorkbenchCloudDeviceRestarts'
import {
  cloudDeviceRestartKey,
  useWorkbenchCloudDeviceRestarts,
} from '@/features/cloud-devices/useWorkbenchCloudDeviceRestarts'
import { useTranslation } from '@/hooks/useTranslation'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canRequestDeviceUpgrade,
  hasWeWorkUpdateAvailable,
  isClaudeCodeDevice,
  isCloudDevice,
  isDeviceBelowWeWorkVersion,
  isDeviceRunningTask,
  isWeWorkCompatibleDevice,
} from '@/lib/device-capabilities'
import {
  findWorkbenchDevice,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
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

const SIDEBAR_TOOLTIP_MAX_WIDTH = 288
const SIDEBAR_TOOLTIP_MARGIN = 8
function getDeviceName(device: DeviceInfo, t: ReturnType<typeof useTranslation>['t']): string {
  return device.name?.trim() || t('workbench.environment_device_unknown', '未知设备')
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
    upgradeState && !['success', 'error', 'skipped', 'busy'].includes(upgradeState.status)
  )
}

export function DeviceStatusPrompt(props: DeviceStatusPromptProps) {
  const cloudRestarts = useWorkbenchCloudDeviceRestarts()
  const activeDevice = findWorkbenchDevice(props.devices, props.activeDeviceId)
  const activeKey = activeDevice ? cloudDeviceRestartKey(activeDevice) : props.activeDeviceId
  const progress = cloudRestarts?.progress ?? {}
  const restartProgress = Object.entries(progress)
    .filter(([key]) => !activeKey || key === activeKey)
    .map(([, entry]) => entry)
  const showOtherDevices =
    !activeKey &&
    props.devices.some(
      device => isClaudeCodeDevice(device) && !progress[cloudDeviceRestartKey(device)]
    )

  return (
    <>
      {restartProgress.length > 0 && (
        <div data-testid="device-status-restart-progress" className={props.className}>
          {restartProgress.map(({ device }) => (
            <CloudDeviceRestartProgress
              key={device.device_id}
              device={device}
              compact={props.presentation === 'sidebar-action'}
            />
          ))}
        </div>
      )}
      {(restartProgress.length === 0 || showOtherDevices) && (
        <DeviceStatusPromptContent {...props} />
      )}
    </>
  )
}

function DeviceStatusPromptContent({
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
  const cloudRestarts = useWorkbenchCloudDeviceRestarts()
  const [manualPending, setManualPending] = useState(false)
  const [sidebarTooltipPosition, setSidebarTooltipPosition] = useState<{
    left: number
    top: number
    maxWidth: number
  } | null>(null)
  const [sidebarTooltipOpen, setSidebarTooltipOpen] = useState(false)
  const sidebarActionRef = useRef<HTMLDivElement>(null)
  const sidebarTooltipRef = useRef<HTMLDivElement>(null)

  const effectiveDevices = useSidebarDeviceObservation(devices, presentation === 'sidebar-action')
  const claudeCodeDevices = useMemo(
    () => effectiveDevices.filter(isClaudeCodeDevice),
    [effectiveDevices]
  )
  const activeDevice = activeDeviceId
    ? findWorkbenchDevice(claudeCodeDevices, activeDeviceId)
    : null
  const compatibleDevices = claudeCodeDevices.filter(isWeWorkCompatibleDevice)
  const outdatedDevices = claudeCodeDevices.filter(isDeviceBelowWeWorkVersion)
  const updateCandidates = claudeCodeDevices.filter(
    device => device.status !== 'offline' && hasWeWorkUpdateAvailable(device)
  )
  const activeUpgradeDevice = (() => {
    if (activeDevice && isUpgradeActive(upgradingDevices[activeDevice.device_id])) {
      return activeDevice
    }
    if (compatibleDevices.length === 0) {
      return claudeCodeDevices.find(device => isUpgradeActive(upgradingDevices[device.device_id]))
    }
    return updateCandidates.find(device => isUpgradeActive(upgradingDevices[device.device_id]))
  })()
  const lowVersionUpgradeCandidates = outdatedDevices.filter(canRequestDeviceUpgrade)
  const lowVersionBlockedDevices = outdatedDevices.filter(
    device => !canRequestDeviceUpgrade(device)
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

  const deviceActions = (deviceIds: string[], upgradeLabel: string) => {
    const cloudTargets = claudeCodeDevices.filter(
      device => isCloudDevice(device) && deviceIds.includes(device.device_id)
    )
    const restartTargets = cloudRestarts
      ? cloudTargets.filter(device => !cloudRestarts.isRestarting(device))
      : []
    const upgradeIds = deviceIds.filter(id => !cloudTargets.some(device => device.device_id === id))
    return [
      ...(upgradeIds.length
        ? [{ name: 'upgrade', label: upgradeLabel, run: () => void runUpgrades(upgradeIds) }]
        : []),
      ...(restartTargets.length && cloudRestarts
        ? [
            {
              name: 'restart',
              label:
                restartTargets.length === 1
                  ? t('workbench.connection_restart_action')
                  : t('workbench.device_status_restart_devices_action', {
                      count: restartTargets.length,
                    }),
              run: () => cloudRestarts.requestRestart(restartTargets),
            },
          ]
        : []),
    ]
  }

  const renderDeviceActionButtons = (
    deviceIds: string[],
    upgradeLabel: string,
    testId: string,
    buttonClass: string
  ) =>
    deviceActions(deviceIds, upgradeLabel).map(({ name, label, run }) => (
      <button
        key={name}
        type="button"
        data-testid={name === 'restart' ? 'device-status-restart-button' : testId}
        disabled={manualPending}
        onClick={run}
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium disabled:cursor-not-allowed disabled:opacity-60',
          name === 'restart' && 'min-h-11 min-w-11 md:min-h-0 md:min-w-0',
          buttonClass
        )}
      >
        {manualPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : name === 'restart' ? (
          <RotateCcw className="h-3.5 w-3.5" />
        ) : (
          <ArrowUpCircle className="h-3.5 w-3.5" />
        )}
        {label}
      </button>
    ))

  const updateSidebarTooltipPosition = () => {
    const rect = sidebarActionRef.current?.getBoundingClientRect()
    if (!rect) return

    const viewportMaxWidth = Math.max(0, window.innerWidth - SIDEBAR_TOOLTIP_MARGIN * 2)
    const maxWidth = Math.min(SIDEBAR_TOOLTIP_MAX_WIDTH, viewportMaxWidth)
    const measuredWidth = sidebarTooltipRef.current?.offsetWidth ?? 0
    const tooltipWidth = measuredWidth > 0 ? measuredWidth : maxWidth
    const maxLeft = Math.max(
      SIDEBAR_TOOLTIP_MARGIN,
      window.innerWidth - tooltipWidth - SIDEBAR_TOOLTIP_MARGIN
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
    const toneClass =
      tone === 'danger'
        ? 'bg-destructive/10 text-destructive hover:bg-destructive/15 disabled:hover:bg-destructive/10 wework:bg-red-50 wework:text-red-600 wework:hover:bg-red-100 wework:disabled:hover:bg-red-50'
        : 'bg-focus/10 text-focus hover:bg-focus/15 disabled:hover:bg-focus/10 wework:bg-blue-50 wework:text-blue-600 wework:hover:bg-blue-100 wework:disabled:hover:bg-blue-50'
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
          sidebarTooltipOpen ? 'block' : 'hidden'
        )}
      >
        {message}
      </div>
    )

    const actions = loading
      ? [{ name: 'upgrade', label: actionLabel, run: undefined }]
      : deviceActions(deviceIds, actionLabel)

    return (
      <>
        <div
          ref={sidebarActionRef}
          data-testid="device-status-prompt"
          className={cn('relative flex shrink-0 gap-1', className)}
          onMouseEnter={openSidebarTooltip}
          onMouseMove={updateSidebarTooltipPosition}
          onMouseLeave={closeSidebarTooltip}
          onFocusCapture={openSidebarTooltip}
          onBlurCapture={closeSidebarTooltip}
        >
          {actions.map(({ name, label, run }) => (
            <button
              key={name}
              type="button"
              data-testid={
                name === 'restart'
                  ? 'device-status-sidebar-restart-button'
                  : 'device-status-sidebar-action-button'
              }
              disabled={manualPending || loading || deviceIds.length === 0}
              onClick={run}
              aria-label={`${label}. ${message}`}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                name === 'restart' && 'min-h-11 min-w-11 md:min-h-0 md:min-w-0',
                toneClass
              )}
            >
              {manualPending || loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : name === 'restart' ? (
                <RotateCcw className="h-3.5 w-3.5" />
              ) : (
                <ArrowUpCircle className="h-3.5 w-3.5" />
              )}
              <span>{label}</span>
            </button>
          ))}
        </div>
        {typeof document === 'undefined' ? tooltip : createPortal(tooltip, document.body)}
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
          className
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">{t('workbench.device_status_no_devices')}</span>
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
      device: getDeviceName(activeUpgradeDevice, t),
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
          className
        )}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        <span className="min-w-0 flex-1 truncate">{message}</span>
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
    const message = isCloudDevice(activeDevice)
      ? t('workbench.device_status_cloud_version_required', {
          device: getDeviceName(activeDevice, t),
          version: WEWORK_MIN_EXECUTOR_VERSION,
        })
      : canUpgrade
        ? t('workbench.device_status_active_upgrade_required', {
            device: getDeviceName(activeDevice, t),
            version: WEWORK_MIN_EXECUTOR_VERSION,
          })
        : t('workbench.device_status_active_upgrade_waiting', {
            device: getDeviceName(activeDevice, t),
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
          'flex items-center gap-2 rounded-lg border border-warning/60 bg-warning/10 px-3 py-2 text-xs text-warning wework:border-amber-300/60 wework:bg-amber-50 wework:text-amber-900',
          compact && 'mx-0',
          className
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning wework:text-amber-600" />
        <span className="min-w-0 flex-1">{message}</span>
        {renderDeviceActionButtons(
          upgradeDeviceIds,
          t('workbench.device_status_upgrade_action'),
          'device-status-upgrade-button',
          'text-warning hover:bg-warning/15 wework:text-amber-900 wework:hover:bg-amber-100'
        )}
      </div>
    )
  }

  if (activeDevice && activeDevice.status !== 'online') {
    if (presentation === 'sidebar-action') return null

    const messageKey =
      isDeviceRunningTask(activeDevice) || activeDevice.status === 'busy'
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
          className
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          {t(messageKey, {
            device:
              activeDevice.status === 'offline'
                ? getWorkbenchDeviceUnavailableDisplayName(activeDevice) ||
                  t('workbench.current_device', '当前设备')
                : getDeviceName(activeDevice, t),
          })}
        </span>
      </div>
    )
  }

  if (compatibleDevices.length === 0 && outdatedDevices.length > 0) {
    const upgradeDevices = lowVersionUpgradeCandidates
    const upgradeDeviceIds = upgradeDevices.map(device => device.device_id)
    const blockedDevice = lowVersionBlockedDevices[0]
    const upgradeDevice = upgradeDevices[0]
    const message = outdatedDevices.some(isCloudDevice)
      ? t('workbench.device_status_cloud_versions_required', {
          version: WEWORK_MIN_EXECUTOR_VERSION,
        })
      : blockedDevice && upgradeDeviceIds.length === 0
        ? t('workbench.device_status_upgrade_waiting', {
            device: getDeviceName(blockedDevice, t),
            reason: getBlockedReason(blockedDevice, t),
            version: WEWORK_MIN_EXECUTOR_VERSION,
          })
        : upgradeDevices.length === 1 && upgradeDevice
          ? t('workbench.device_status_upgrade_required_device', {
              device: getDeviceName(upgradeDevice, t),
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
          'flex items-center gap-2 rounded-lg border border-warning/60 bg-warning/10 px-3 py-2 text-xs text-warning wework:border-amber-300/60 wework:bg-amber-50 wework:text-amber-900',
          compact && 'mx-0',
          className
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning wework:text-amber-600" />
        <span className="min-w-0 flex-1">{message}</span>
        {renderDeviceActionButtons(
          upgradeDeviceIds,
          upgradeDevices.length === 1
            ? t('workbench.device_status_upgrade_single_action')
            : t('workbench.device_status_upgrade_devices_action', { count: upgradeDevices.length }),
          'device-status-upgrade-button',
          'text-warning hover:bg-warning/15 wework:text-amber-900 wework:hover:bg-amber-100'
        )}
      </div>
    )
  }

  if (
    requiresOnlineCompatibleDevice &&
    compatibleDevices.length > 0 &&
    !compatibleDevices.some(isWorkbenchDeviceOnline)
  ) {
    if (presentation === 'sidebar-action') return null

    return (
      <div
        data-testid="device-status-prompt"
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-secondary',
          compact && 'mx-0',
          className
        )}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">{t('workbench.device_status_no_online_device')}</span>
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
          className
        )}
      >
        <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          {t('workbench.device_status_update_available', {
            count: updateCandidates.length,
          })}
        </span>
        {renderDeviceActionButtons(
          upgradeDeviceIds,
          t('workbench.device_status_update_action'),
          'device-status-update-button',
          'text-primary hover:bg-primary/10'
        )}
      </div>
    )
  }

  return null
}
