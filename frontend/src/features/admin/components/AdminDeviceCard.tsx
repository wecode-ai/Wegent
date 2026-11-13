// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import {
  ArrowUpCircle,
  Cloud,
  HardDrive,
  Loader2,
  MoveRight,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import type { AdminDeviceInfo, BindShell, DeviceType } from '@/apis/admin'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn, isVersionAtLeast } from '@/lib/utils'
import type { DeviceUpgradeStatusPayload } from '@/types/socket'

const MIN_AUTO_UPGRADE_VERSION = '1.6.5'
const TERMINAL_UPGRADE_STATUSES = ['success', 'error', 'skipped'] as const

export interface DeviceUpgradeState {
  status: DeviceUpgradeStatusPayload['status']
  message: string
  progress?: number
}

export function isTerminalUpgradeStatus(status: DeviceUpgradeStatusPayload['status']) {
  return TERMINAL_UPGRADE_STATUSES.includes(status as (typeof TERMINAL_UPGRADE_STATUSES)[number])
}

function getStatusTag(status: string, t: (key: string) => string) {
  switch (status) {
    case 'online':
      return <Tag variant="success">{t('device_monitor.status.online')}</Tag>
    case 'offline':
      return <Tag variant="default">{t('device_monitor.status.offline')}</Tag>
    case 'busy':
      return <Tag variant="warning">{t('device_monitor.status.busy')}</Tag>
    default:
      return <Tag variant="default">{status}</Tag>
  }
}

function getDeviceTypeTag(deviceType: DeviceType, t: (key: string) => string) {
  switch (deviceType) {
    case 'local':
      return (
        <Tag variant="info" className="flex items-center gap-1">
          <HardDrive className="w-3 h-3" />
          {t('device_monitor.device_type.local')}
        </Tag>
      )
    case 'cloud':
      return (
        <Tag variant="info" className="flex items-center gap-1">
          <Cloud className="w-3 h-3" />
          {t('device_monitor.device_type.cloud')}
        </Tag>
      )
    default:
      return <Tag variant="default">{deviceType}</Tag>
  }
}

function getBindShellTag(bindShell: BindShell, t: (key: string) => string) {
  switch (bindShell) {
    case 'claudecode':
      return <Tag variant="default">{t('device_monitor.bind_shell.claudecode')}</Tag>
    case 'openclaw':
      return <Tag variant="default">{t('device_monitor.bind_shell.openclaw')}</Tag>
    default:
      return <Tag variant="default">{bindShell}</Tag>
  }
}

interface AdminDeviceCardProps {
  device: AdminDeviceInfo
  upgradeState?: DeviceUpgradeState
  actionLoading: Record<string, string>
  extensionAction: ReactNode
  deleteDisabled: boolean
  handleUpgrade: (device: AdminDeviceInfo) => void
  handleRestart: (device: AdminDeviceInfo) => void
  handleMigrate: (device: AdminDeviceInfo) => void
  onDelete: (device: AdminDeviceInfo) => void
}

export function AdminDeviceCard({
  device,
  upgradeState,
  actionLoading,
  extensionAction,
  deleteDisabled,
  handleUpgrade,
  handleRestart,
  handleMigrate,
  onDelete,
}: AdminDeviceCardProps) {
  const { t } = useTranslation('admin')
  const isOnline = device.status === 'online'
  const isCloud = device.device_type === 'cloud'
  const supportsUpgrade = device.bind_shell === 'claudecode' && device.device_type !== 'app'
  const isUpgradeInProgress = !!upgradeState
  const canUpgrade =
    isOnline &&
    supportsUpgrade &&
    device.executor_version &&
    isVersionAtLeast(device.executor_version, MIN_AUTO_UPGRADE_VERSION)
  const upgradeKey = `${device.device_id}-upgrade`
  const restartKey = `${device.device_id}-restart`
  const migrateKey = `${device.device_id}-migrate`

  return (
    <Card
      className="p-3 bg-base hover:bg-hover transition-colors"
      data-testid={`device-card-${device.device_id}`}
    >
      <div className="flex items-start justify-between min-w-0 gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-medium text-text-primary">{device.name}</span>
            {getStatusTag(device.status, t)}
            {getDeviceTypeTag(device.device_type, t)}
            {getBindShellTag(device.bind_shell, t)}
            {device.executor_version && (
              <Tag variant="default" className="text-xs">
                v{device.executor_version}
              </Tag>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted flex-wrap">
            <span>
              {t('device_monitor.columns.device_id')}: {device.device_id}
            </span>
            <span>
              {t('device_monitor.columns.user')}: {device.user_name}
            </span>
            {device.client_ip && (
              <span>
                {t('device_monitor.columns.ip')}: {device.client_ip}
              </span>
            )}
            {device.created_at && (
              <span>
                {t('device_monitor.columns.created_at')}:{' '}
                {new Date(device.created_at).toLocaleString()}
              </span>
            )}
          </div>
          {upgradeState && (
            <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary flex-wrap">
              <Loader2
                className={cn(
                  'h-3.5 w-3.5',
                  !isTerminalUpgradeStatus(upgradeState.status) && 'animate-spin'
                )}
              />
              <span>{upgradeState.message}</span>
              {typeof upgradeState.progress === 'number' && (
                <span>{Math.round(upgradeState.progress)}%</span>
              )}
            </div>
          )}
        </div>
        {/* Action Buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <TooltipProvider>
            {/* Upgrade Button - ClaudeCode only, available for online devices with version >= 1.6.5 */}
            {supportsUpgrade && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={!canUpgrade || !!actionLoading[upgradeKey] || isUpgradeInProgress}
                    onClick={() => handleUpgrade(device)}
                    data-testid={`upgrade-device-${device.device_id}`}
                  >
                    <ArrowUpCircle
                      className={cn(
                        'h-4 w-4',
                        (actionLoading[upgradeKey] || isUpgradeInProgress) && 'animate-pulse'
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {isUpgradeInProgress
                    ? upgradeState.message
                    : canUpgrade
                      ? t('device_monitor.actions.upgrade')
                      : t('device_monitor.actions.upgrade_unsupported', {
                          version: MIN_AUTO_UPGRADE_VERSION,
                        })}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Restart Button - cloud only */}
            {isCloud && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={!!actionLoading[restartKey]}
                    onClick={() => handleRestart(device)}
                    data-testid={`restart-device-${device.device_id}`}
                  >
                    <RotateCcw
                      className={cn('h-4 w-4', actionLoading[restartKey] && 'animate-spin')}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('device_monitor.actions.restart')}</TooltipContent>
              </Tooltip>
            )}

            {/* Migrate Button - cloud only */}
            {isCloud && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={!!actionLoading[migrateKey]}
                    onClick={() => handleMigrate(device)}
                    data-testid={`migrate-device-${device.device_id}`}
                  >
                    <MoveRight
                      className={cn('h-4 w-4', actionLoading[migrateKey] && 'animate-pulse')}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('device_monitor.actions.migrate')}</TooltipContent>
              </Tooltip>
            )}
            {device.status === 'offline' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 text-error md:h-8 md:w-8"
                    aria-label={t('device_monitor.actions.delete')}
                    disabled={deleteDisabled}
                    onClick={() => onDelete(device)}
                    data-testid={`admin-delete-device-${device.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('device_monitor.actions.delete')}</TooltipContent>
              </Tooltip>
            )}
          </TooltipProvider>
          {extensionAction}
        </div>
      </div>
    </Card>
  )
}
