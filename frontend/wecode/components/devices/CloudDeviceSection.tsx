// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud device section component.
 *
 * Displays cloud devices and provides actions for creating/deleting cloud devices.
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
import { Cloud, Plus, Loader2, Trash2, Play, Star, MoreVertical } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { cloudDeviceApis, CloudDeviceConfig } from '@wecode/apis/cloud-devices'
import type { DeviceInfo } from '@/apis/devices'
import { SlotIndicator } from '@/features/devices/components/SlotIndicator'
import { VersionBadge } from '@/features/devices/components/VersionBadge'

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
  onDeleteDevice,
  onSetDefault,
  onStartTask,
  onCancelTask,
}: CloudDeviceSectionProps) {
  const { t } = useTranslation('wecode')
  const [isCreating, setIsCreating] = useState(false)
  const [deviceToDelete, setDeviceToDelete] = useState<DeviceInfo | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [cloudConfig, setCloudConfig] = useState<CloudDeviceConfig | null>(null)

  // Fetch cloud device configuration
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const config = await cloudDeviceApis.getCloudDeviceConfig()
        setCloudConfig(config)
      } catch (error) {
        console.error('Failed to fetch cloud device config:', error)
      }
    }
    fetchConfig()
  }, [])

  const handleCreateCloudDevice = useCallback(async () => {
    setIsCreating(true)
    try {
      await cloudDeviceApis.createCloudDevice()
      toast.success(t('cloud_device.create_success'))
      onDeviceCreated()
    } catch (error: unknown) {
      const apiError = error as { status?: number; message?: string }
      if (apiError?.status === 400) {
        toast.error(t('cloud_device.limit_reached', { max: cloudConfig?.max_devices_per_user || 3 }))
      } else if (apiError?.status === 503) {
        toast.error(t('cloud_device.not_configured'))
      } else {
        toast.error(t('cloud_device.create_error'))
      }
    } finally {
      setIsCreating(false)
    }
  }, [t, onDeviceCreated, cloudConfig])

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

  // Don't render if cloud devices are not enabled
  if (cloudConfig && !cloudConfig.enabled) {
    return null
  }

  const canCreateMore = !cloudConfig || cloudDevices.length < cloudConfig.max_devices_per_user

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold flex items-center gap-2 text-text-primary">
          <Cloud className="w-5 h-5 text-primary" />
          {t('cloud_device.title')}
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCreateCloudDevice}
          disabled={isCreating || !canCreateMore}
          className="h-8"
        >
          {isCreating ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 mr-2" />
          )}
          {t('cloud_device.create')}
        </Button>
      </div>

      {/* Cloud devices list */}
      {cloudDevices.length === 0 ? (
        <div className="text-center py-8 text-text-muted">
          <Cloud className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('cloud_device.empty')}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {cloudDevices.map((device) => (
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
              {isDeleting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
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
  const canStartTask = isOnline && device.slot_used < device.slot_max

  return (
    <div
      className={cn(
        'border rounded-lg p-4 bg-surface transition-all',
        isOnline ? 'border-primary/30' : 'border-border opacity-60'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: Device info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Cloud icon with status indicator */}
          <div className="relative">
            <Cloud
              className={cn(
                'w-8 h-8',
                isOnline ? 'text-primary' : 'text-text-muted'
              )}
            />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-surface',
                device.status === 'online' && 'bg-green-500',
                device.status === 'busy' && 'bg-yellow-500',
                device.status === 'offline' && 'bg-gray-400'
              )}
            />
          </div>

          {/* Device details */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-medium text-text-primary truncate">{device.name}</h4>
              {device.is_default && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger>
                      <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('devices:default_device')}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>

            <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
              <span className="truncate" title={device.device_id}>
                {device.device_id.slice(0, 16)}...
              </span>
              <SlotIndicator
                used={device.slot_used}
                max={device.slot_max}
                runningTasks={device.running_tasks}
              />
            </div>

            {/* Version badge */}
            {isOnline && (
              <div className="mt-2">
                <VersionBadge
                  executorVersion={device.executor_version}
                  latestVersion={device.latest_version}
                  updateAvailable={device.update_available}
                />
              </div>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* Start task button */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onStartTask(device.device_id)}
                  disabled={!canStartTask}
                  className="h-8 px-3"
                >
                  <Play className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('devices:start_task')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          {/* More actions dropdown */}
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
                {t('common:actions.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Running tasks */}
      {device.running_tasks.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-xs text-text-muted mb-2">
            {t('devices:running_tasks_count', { count: device.running_tasks.length })}
          </p>
          <div className="space-y-1">
            {device.running_tasks.slice(0, 3).map((task) => (
              <div
                key={task.subtask_id}
                className="flex items-center justify-between text-xs"
              >
                <span className="truncate flex-1 text-text-secondary">{task.title}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => onCancelTask(task.task_id)}
                >
                  {t('common:actions.cancel')}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
