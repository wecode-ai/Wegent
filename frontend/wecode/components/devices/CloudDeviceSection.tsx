// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device section component.
 *
 * Groups cloud devices by sandboxId into machine cards.
 * Each machine may have multiple devices (executor + OpenClaw).
 */

'use client'

import '@wecode/i18n' // side-effect import to load wecode translations
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Cloud, Loader2, Trash2, Play, Star, MoreVertical, ExternalLink } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { cloudDeviceApis } from '@wecode/apis/cloud-devices'
import { isVersionAtLeast } from '@wecode/lib/version'
import type { DeviceInfo } from '@/apis/devices'
import { SlotIndicator } from '@/features/devices/components/SlotIndicator'
import { VersionBadge } from '@/features/devices/components/VersionBadge'
import { RunningTasksList } from '@/features/devices/components/RunningTasksList'
import type { DeviceUpgradeState } from '@/contexts/DeviceContext'

/**
 * Group cloud devices by sandboxId into machine groups.
 * Each group represents one physical/virtual machine.
 */
function groupDevicesByMachine(devices: DeviceInfo[]): Record<string, DeviceInfo[]> {
  const groups: Record<string, DeviceInfo[]> = {}
  for (const device of devices) {
    const key = device.cloud_config?.sandboxId ?? device.device_id
    if (!groups[key]) groups[key] = []
    groups[key].push(device)
  }
  return groups
}

/**
 * Get the primary device (executor/claudecode) from a machine group.
 * Falls back to the first device if no executor found.
 */
function getPrimaryDevice(devices: DeviceInfo[]): DeviceInfo {
  return devices.find(d => d.bind_shell !== 'openclaw') ?? devices[0]
}

interface CloudDeviceSectionProps {
  cloudDevices: DeviceInfo[]
  onDeviceCreated: () => void
  onDeleteDevice: (device: DeviceInfo) => Promise<void>
  onSetDefault: (device: DeviceInfo) => Promise<void>
  onStartTask: (deviceId: string) => void
  onCancelTask: (taskId: number) => Promise<void>
  onUpgradeDevice?: (deviceId: string) => void
  isDeviceUpgrading?: (deviceId: string) => boolean
  getUpgradeStatus?: (deviceId: string) => DeviceUpgradeState | undefined
}

export function CloudDeviceSection({
  cloudDevices,
  onDeviceCreated,
  onDeleteDevice: _onDeleteDevice,
  onSetDefault,
  onStartTask,
  onCancelTask,
  onUpgradeDevice,
  isDeviceUpgrading,
  getUpgradeStatus,
}: CloudDeviceSectionProps) {
  const { t } = useTranslation('wecode')
  const [deviceToDelete, setDeviceToDelete] = useState<DeviceInfo | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Group devices by sandboxId
  const machineGroups = useMemo(() => groupDevicesByMachine(cloudDevices), [cloudDevices])
  const machineCount = Object.keys(machineGroups).length

  const handleDeleteConfirm = useCallback(async () => {
    if (!deviceToDelete) return

    setIsDeleting(true)
    try {
      // Use cloud device API for deletion (backend cascades to all devices in same sandbox)
      await cloudDeviceApis.deleteCloudDevice(deviceToDelete.device_id)
      toast.success(t('cloud_device.delete_success'))
      // Notify parent to refresh device list
      onDeviceCreated()
    } catch (error) {
      console.error('Failed to delete cloud device:', error)
      toast.error(t('cloud_device.delete_error'))
    } finally {
      setIsDeleting(false)
      setDeviceToDelete(null)
    }
  }, [deviceToDelete, t, onDeviceCreated])

  // Check if any device is being created
  const hasCreatingDevice = cloudDevices.some(device => {
    // Check if device is offline and was recently created (within 3 minutes)
    if (device.status === 'offline' && device.cloud_config?.createdAt) {
      const createdAt = new Date(device.cloud_config.createdAt)
      const now = new Date()
      const diffMinutes = (now.getTime() - createdAt.getTime()) / 1000 / 60
      return diffMinutes < 3
    }

    return false
  })

  // Auto-refresh when devices are being created
  useEffect(() => {
    if (!hasCreatingDevice) return

    const interval = setInterval(() => {
      onDeviceCreated() // Trigger refresh
    }, 10000) // 10 seconds

    return () => clearInterval(interval)
  }, [hasCreatingDevice, onDeviceCreated])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Cloud className="w-5 h-5 text-text-secondary" />
        <h3 className="text-sm font-medium text-text-secondary">{t('cloud_device.title')}</h3>
        <span className="text-xs text-text-muted">({machineCount})</span>
        <a
          href="https://cloud.nevis.sina.com.cn/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary bg-primary/10 rounded-full hover:bg-primary/20 transition-colors"
        >
          {t('cloud_device.powered_by_prefix')}Nevis{t('cloud_device.powered_by_suffix')}
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {/* Creating notice alert */}
      {hasCreatingDevice && (
        <Alert variant="success">
          <Loader2 className="w-4 h-4 animate-spin" />
          <AlertDescription>{t('cloud_device.creating_notice')}</AlertDescription>
        </Alert>
      )}

      {/* Cloud machine list */}
      {machineCount === 0 ? (
        <div className="text-center py-8 text-text-muted">
          <Cloud className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('cloud_device.empty')}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {Object.entries(machineGroups).map(([sandboxId, devices]) => (
            <CloudMachineCard
              key={sandboxId}
              devices={devices}
              onStartTask={onStartTask}
              onSetDefault={onSetDefault}
              onDelete={device => setDeviceToDelete(device)}
              onCancelTask={onCancelTask}
              onUpgradeDevice={onUpgradeDevice}
              isDeviceUpgrading={isDeviceUpgrading}
              getUpgradeStatus={getUpgradeStatus}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deviceToDelete} onOpenChange={() => setDeviceToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('cloud_device.delete_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('cloud_device.delete_confirm_message')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('common:actions.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {t('common:actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

interface CloudMachineCardProps {
  devices: DeviceInfo[]
  onStartTask: (deviceId: string) => void
  onSetDefault: (device: DeviceInfo) => Promise<void>
  onDelete: (device: DeviceInfo) => void
  onCancelTask: (taskId: number) => Promise<void>
  onUpgradeDevice?: (deviceId: string) => void
  isDeviceUpgrading?: (deviceId: string) => boolean
  getUpgradeStatus?: (deviceId: string) => DeviceUpgradeState | undefined
  t: (key: string, options?: Record<string, unknown>) => string
}

/**
 * Card representing a single cloud machine (VM).
 * May contain multiple devices (e.g., executor + OpenClaw).
 */
// Minimum version required for auto-upgrade
const MIN_UPGRADE_VERSION = '1.6.5'

function CloudMachineCard({
  devices,
  onStartTask,
  onSetDefault,
  onDelete,
  onCancelTask,
  onUpgradeDevice,
  isDeviceUpgrading,
  getUpgradeStatus,
  t,
}: CloudMachineCardProps) {
  const primaryDevice = getPrimaryDevice(devices)
  const isAnyOnline = devices.some(d => d.status === 'online' || d.status === 'busy')

  // Get upgrade status
  const isUpgrading = isDeviceUpgrading?.(primaryDevice.device_id) ?? false
  const upgradeStatus = getUpgradeStatus?.(primaryDevice.device_id)

  // Check if device supports auto-upgrade (>= 1.6.5)
  const supportsAutoUpgrade = useMemo(() => {
    if (!primaryDevice.executor_version) return false
    return isVersionAtLeast(primaryDevice.executor_version, MIN_UPGRADE_VERSION)
  }, [primaryDevice.executor_version])

  // Handle upgrade with version check
  const handleUpgrade = useCallback(() => {
    if (!supportsAutoUpgrade) {
      toast.error(t('upgrade.cloud_version_not_supported'))
      return
    }
    onUpgradeDevice?.(primaryDevice.device_id)
  }, [supportsAutoUpgrade, onUpgradeDevice, primaryDevice.device_id, t])

  const getMachineStatusColor = () => {
    if (devices.some(d => d.status === 'online')) return 'bg-green-500'
    if (devices.some(d => d.status === 'busy')) return 'bg-yellow-500'
    return 'bg-gray-400'
  }

  const getMachineStatusText = () => {
    if (devices.some(d => d.status === 'online')) return t('devices:status_online')
    if (devices.some(d => d.status === 'busy')) return t('devices:status_busy')
    return t('devices:status_offline')
  }

  // Collect all running tasks across all devices
  const allRunningTasks = devices.flatMap(d => d.running_tasks)

  return (
    <div
      className={cn(
        'bg-surface border rounded-lg p-4',
        primaryDevice.is_default ? 'border-primary' : 'border-border'
      )}
    >
      {/* Machine header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Cloud className="w-5 h-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-text-primary">{primaryDevice.name}</h4>
              {primaryDevice.is_default && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full">
                  <Star className="w-3 h-3 fill-current" />
                  {t('devices:default_device')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-muted">{primaryDevice.device_id}</p>
              {isAnyOnline && primaryDevice.executor_version && (
                <VersionBadge
                  executorVersion={primaryDevice.executor_version}
                  latestVersion={primaryDevice.latest_version}
                  updateAvailable={primaryDevice.update_available}
                  onUpgrade={
                    primaryDevice.update_available &&
                    primaryDevice.status === 'online' &&
                    !isUpgrading
                      ? handleUpgrade
                      : undefined
                  }
                  isUpgrading={isUpgrading}
                />
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full', getMachineStatusColor())} />
            <span className="text-sm text-text-secondary">{getMachineStatusText()}</span>
          </div>
          {/* Upgrade progress */}
          {isUpgrading && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{upgradeStatus?.message || t('devices:upgrade.inProgress')}</span>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
                data-testid="cloud-machine-menu"
              >
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!primaryDevice.is_default && (
                <DropdownMenuItem onClick={() => onSetDefault(primaryDevice)}>
                  <Star className="w-4 h-4 mr-2" />
                  {t('devices:set_as_default')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => onDelete(primaryDevice)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {t('devices:delete_device')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Device capability rows */}
      <div className="mt-3 space-y-2">
        {devices.map(device => (
          <DeviceCapabilityRow
            key={device.device_id}
            device={device}
            onStartTask={onStartTask}
            t={t}
          />
        ))}
      </div>

      {/* Running tasks list (aggregated from all devices) */}
      {allRunningTasks.length > 0 && (
        <RunningTasksList
          tasks={allRunningTasks}
          deviceName={primaryDevice.name}
          onCancelTask={onCancelTask}
        />
      )}
    </div>
  )
}

interface DeviceCapabilityRowProps {
  device: DeviceInfo
  onStartTask: (deviceId: string) => void
  t: (key: string, options?: Record<string, unknown>) => string
}

/**
 * A row within a machine card showing one device capability (Executor or OpenClaw)
 * with its own online status and start task button.
 */
function DeviceCapabilityRow({ device, onStartTask, t }: DeviceCapabilityRowProps) {
  const isOnline = device.status === 'online' || device.status === 'busy'
  const slotsAvailable = device.slot_max === 0 || device.slot_used < device.slot_max
  const canStartTask = isOnline && slotsAvailable
  const isOpenClaw = device.bind_shell === 'openclaw'

  const capabilityLabel = isOpenClaw ? '🦞 openclaw' : 'claudecode'

  const statusColor = isOnline
    ? device.status === 'busy'
      ? 'bg-yellow-500'
      : 'bg-green-500'
    : 'bg-gray-400'

  return (
    <div className="flex items-center justify-between pl-14 py-1.5">
      <div className="flex items-center gap-2.5">
        <span className={cn('w-1.5 h-1.5 rounded-full', statusColor)} />
        <span className="text-sm text-text-primary truncate max-w-[240px]">{device.name}</span>
        <span
          className={cn(
            'inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded',
            isOpenClaw ? 'bg-red-50 text-red-600' : 'bg-primary/10 text-primary'
          )}
        >
          {capabilityLabel}
        </span>
        {/* Slot indicator for online devices */}
        {isOnline && device.slot_used > 0 && (
          <SlotIndicator
            used={device.slot_used}
            max={device.slot_max}
            runningTasks={device.running_tasks}
          />
        )}
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Button
                variant="default"
                size="sm"
                onClick={() => onStartTask(device.device_id)}
                disabled={!canStartTask}
                className="flex items-center gap-2"
                data-testid={`start-task-${device.bind_shell ?? 'executor'}`}
              >
                <Play className="w-4 h-4" />
                {!slotsAvailable ? t('devices:slots_full') : t('devices:start_task')}
              </Button>
            </div>
          </TooltipTrigger>
          {!canStartTask && isOnline && !slotsAvailable && (
            <TooltipContent>
              <p className="text-sm">{t('devices:slots_full_hint')}</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
