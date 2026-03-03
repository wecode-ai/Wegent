// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device section component.
 *
 * Displays cloud devices and provides actions for deleting cloud devices.
 */

'use client'

import '@wecode/i18n' // side-effect import to load wecode translations
import { useState, useEffect, useCallback } from 'react'
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
import { Cloud, Loader2, Trash2, Play, Star, MoreVertical } from 'lucide-react'
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
import type { DeviceInfo } from '@/apis/devices'
import { SlotIndicator } from '@/features/devices/components/SlotIndicator'
import { VersionBadge } from '@/features/devices/components/VersionBadge'
import { RunningTasksList } from '@/features/devices/components/RunningTasksList'

interface CloudDeviceSectionProps {
  cloudDevices: DeviceInfo[]
  onDeviceCreated: () => void
  onDeleteDevice: (device: DeviceInfo) => Promise<void>
  onSetDefault: (device: DeviceInfo) => Promise<void>
  onStartTask: (deviceId: string) => void
  onCancelTask: (taskId: number) => Promise<void>
}

export function CloudDeviceSection({
  cloudDevices,
  onDeviceCreated,
  onDeleteDevice: _onDeleteDevice,
  onSetDefault,
  onStartTask,
  onCancelTask,
}: CloudDeviceSectionProps) {
  const { t } = useTranslation('wecode')
  const [deviceToDelete, setDeviceToDelete] = useState<DeviceInfo | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDeleteConfirm = useCallback(async () => {
    if (!deviceToDelete) return

    setIsDeleting(true)
    try {
      // Use cloud device API for deletion
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
        <span className="text-xs text-text-muted">({cloudDevices.length})</span>
      </div>

      {/* Creating notice alert */}
      {hasCreatingDevice && (
        <Alert variant="success">
          <Loader2 className="w-4 h-4 animate-spin" />
          <AlertDescription>{t('cloud_device.creating_notice')}</AlertDescription>
        </Alert>
      )}

      {/* Cloud devices list */}
      {cloudDevices.length === 0 ? (
        <div className="text-center py-8 text-text-muted">
          <Cloud className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('cloud_device.empty')}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {cloudDevices.map(device => (
            <CloudDeviceCard
              key={device.device_id}
              device={device}
              onStartTask={onStartTask}
              onSetDefault={onSetDefault}
              onDelete={() => setDeviceToDelete(device)}
              onCancelTask={onCancelTask}
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

interface CloudDeviceCardProps {
  device: DeviceInfo
  onStartTask: (deviceId: string) => void
  onSetDefault: (device: DeviceInfo) => Promise<void>
  onDelete: () => void
  onCancelTask: (taskId: number) => Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

function CloudDeviceCard({
  device,
  onStartTask,
  onSetDefault,
  onDelete,
  onCancelTask,
  t,
}: CloudDeviceCardProps) {
  const isOnline = device.status === 'online' || device.status === 'busy'
  const slotsAvailable = device.slot_max === 0 || device.slot_used < device.slot_max
  const canStartTask = isOnline && slotsAvailable

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-500'
      case 'busy':
        return 'bg-yellow-500'
      default:
        return 'bg-gray-400'
    }
  }

  const getStatusText = (status: string) => {
    switch (status) {
      case 'online':
        return t('devices:status_online')
      case 'busy':
        return t('devices:status_busy')
      default:
        return t('devices:status_offline')
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
            <Cloud className="w-5 h-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-text-primary">{device.name}</h4>
              {device.is_default && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full">
                  <Star className="w-3 h-3 fill-current" />
                  {t('devices:default_device')}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-muted">{device.device_id}</p>
              {isOnline && (
                <VersionBadge
                  executorVersion={device.executor_version}
                  latestVersion={device.latest_version}
                  updateAvailable={device.update_available}
                />
              )}
            </div>
            {/* Slot indicator - only show for online devices */}
            {isOnline && (
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
                  >
                    <Play className="w-4 h-4" />
                    {!slotsAvailable ? t('devices:slots_full') : t('devices:start_task')}
                  </Button>
                </div>
              </TooltipTrigger>
              {!slotsAvailable && isOnline && (
                <TooltipContent>
                  <p className="text-sm">{t('devices:slots_full_hint')}</p>
                </TooltipContent>
              )}
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
                  {t('devices:set_as_default')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={onDelete}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {t('devices:delete_device')}
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
