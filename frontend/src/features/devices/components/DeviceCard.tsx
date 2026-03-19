// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Device card component.
 * Displays device information, status, actions, and running tasks.
 */

'use client'

import { Monitor, Play, Star, MoreVertical, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { DeviceInfo } from '@/apis/devices'
import { DeviceUpgradeState } from '@/contexts/DeviceContext'
import { SlotIndicator } from './SlotIndicator'
import { RunningTasksList } from './RunningTasksList'
import { VersionBadge } from './VersionBadge'
import { getStatusColor, isOpenClawDevice } from '../utils/device-status'
import { useTranslation } from '@/hooks/useTranslation'

export interface DeviceCardProps {
  device: DeviceInfo
  onStartTask: (deviceId: string) => void
  onSetDefault: (device: DeviceInfo) => void
  onDelete: (device: DeviceInfo) => void
  onCancelTask: (taskId: number) => Promise<void>
  onUpgrade?: (deviceId: string) => void
  isUpgrading?: boolean
  upgradeStatus?: DeviceUpgradeState
}

/**
 * Device card displaying device info, status, and actions.
 *
 * Features:
 * - Device name, ID, status indicator
 * - Version badge (when online)
 * - Slot indicator (when online)
 * - Start Task button (enabled only when online)
 * - Dropdown menu: Set as Default, Delete Device
 * - Running tasks list (expandable)
 */
export function DeviceCard({
  device,
  onStartTask,
  onSetDefault,
  onDelete,
  onCancelTask,
  onUpgrade,
  isUpgrading,
  upgradeStatus,
}: DeviceCardProps) {
  const { t } = useTranslation('devices')

  /**
   * Get localized status text.
   * Helper function that uses i18n, kept local to component.
   */
  const getStatusText = (status: string) => {
    switch (status) {
      case 'online':
        return t('status_online')
      case 'busy':
        return t('status_busy')
      default:
        return t('status_offline')
    }
  }

  return (
    <div
      className={cn(
        'bg-surface border rounded-lg p-4',
        device.is_default ? 'border-primary' : 'border-border'
      )}
    >
      {/* Device info row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Monitor className="w-5 h-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-text-primary">{device.name}</h4>
              {device.is_default && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full">
                  <Star className="w-3 h-3 fill-current" />
                  {t('default_device')}
                </span>
              )}
              {isOpenClawDevice(device) && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-red-50 text-red-600 rounded-full">
                  {t('openclaw_badge')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-muted">{device.device_id}</p>
              {device.status !== 'offline' && (
                <VersionBadge
                  executorVersion={device.executor_version}
                  latestVersion={device.latest_version}
                  updateAvailable={device.update_available}
                  onUpgrade={device.update_available && device.status === 'online' && !isUpgrading ? () => onUpgrade?.(device.device_id) : undefined}
                  isUpgrading={isUpgrading}
                />
              )}
            </div>
            {/* Slot indicator - only show for online devices */}
            {device.status !== 'offline' && (
              <div className="mt-1">
                <SlotIndicator
                  used={device.slot_used}
                  max={device.slot_max}
                  runningTasks={device.running_tasks}
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full', getStatusColor(device.status))} />
            <span className="text-sm text-text-secondary">{getStatusText(device.status)}</span>
          </div>
          {/* Upgrade progress */}
          {isUpgrading && (
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{upgradeStatus?.message || t('upgrade.inProgress')}</span>
            </div>
          )}

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onStartTask(device.device_id)}
                    disabled={device.status !== 'online'}
                    className="flex items-center gap-2"
                  >
                    <Play className="w-4 h-4" />
                    {t('start_task')}
                  </Button>
                </div>
              </TooltipTrigger>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!device.is_default && (
                <DropdownMenuItem onClick={() => onSetDefault(device)}>
                  <Star className="w-4 h-4 mr-2" />
                  {t('set_as_default')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem danger onClick={() => onDelete(device)}>
                <Trash2 className="w-4 h-4 mr-2" />
                {t('delete_device')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Running tasks list */}
      {device.running_tasks.length > 0 && (
        <RunningTasksList
          tasks={device.running_tasks}
          deviceName={device.name}
          onCancelTask={onCancelTask}
        />
      )}
    </div>
  )
}
