// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { adminApis, AdminDeviceInfo, AdminDeviceStats, DeviceType, BindShell } from '@/apis/admin'
import { toast } from 'sonner'
import {
  Monitor,
  Wifi,
  WifiOff,
  Cloud,
  HardDrive,
  RefreshCw,
  Search,
  Users,
  ArrowUpCircle,
  RotateCcw,
  MoveRight,
} from 'lucide-react'
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tag } from '@/components/ui/tag'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn, isVersionAtLeast } from '@/lib/utils'

// Minimum version required for auto-upgrade support
const MIN_AUTO_UPGRADE_VERSION = '1.6.5'

interface StatCardProps {
  title: string
  value: number | string
  icon: React.ReactNode
  variant?: 'default' | 'success' | 'warning' | 'error'
}

function StatCard({ title, value, icon, variant = 'default' }: StatCardProps) {
  const variantClasses = {
    default: 'bg-card border-border',
    success: 'bg-green-500/10 border-green-500/30',
    warning: 'bg-yellow-500/10 border-yellow-500/30',
    error: 'bg-red-500/10 border-red-500/30',
  }

  const iconClasses = {
    default: 'text-text-muted',
    success: 'text-green-500',
    warning: 'text-yellow-500',
    error: 'text-red-500',
  }

  return (
    <div className={cn('rounded-lg border p-4', variantClasses[variant])}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-muted">{title}</p>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
        </div>
        <div className={cn('p-2 rounded-full bg-muted', iconClasses[variant])}>{icon}</div>
      </div>
    </div>
  )
}

function getStatusTag(status: string, t: (key: string) => string) {
  switch (status) {
    case 'online':
      return <Tag variant="success">{t('admin:device_monitor.status.online')}</Tag>
    case 'offline':
      return <Tag variant="default">{t('admin:device_monitor.status.offline')}</Tag>
    case 'busy':
      return <Tag variant="warning">{t('admin:device_monitor.status.busy')}</Tag>
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
          {t('admin:device_monitor.device_type.local')}
        </Tag>
      )
    case 'cloud':
      return (
        <Tag variant="info" className="flex items-center gap-1">
          <Cloud className="w-3 h-3" />
          {t('admin:device_monitor.device_type.cloud')}
        </Tag>
      )
    default:
      return <Tag variant="default">{deviceType}</Tag>
  }
}

function getBindShellTag(bindShell: BindShell, t: (key: string) => string) {
  switch (bindShell) {
    case 'claudecode':
      return <Tag variant="default">{t('admin:device_monitor.bind_shell.claudecode')}</Tag>
    case 'openclaw':
      return <Tag variant="default">{t('admin:device_monitor.bind_shell.openclaw')}</Tag>
    default:
      return <Tag variant="default">{bindShell}</Tag>
  }
}

export function DeviceMonitorPanel() {
  const { t } = useTranslation()
  const [stats, setStats] = useState<AdminDeviceStats | null>(null)
  const [devices, setDevices] = useState<AdminDeviceInfo[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({})

  // Filter states
  const [deviceTypeFilter, setDeviceTypeFilter] = useState<string>('all')
  const [bindShellFilter, setBindShellFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(1)
  const limit = 20

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  const loadStats = useCallback(async () => {
    try {
      const data = await adminApis.getDeviceStats()
      setStats(data)
    } catch (error) {
      console.error('Failed to load device stats:', error)
      toast.error(t('admin:device_monitor.errors.load_stats_failed'))
    }
  }, [t])

  const loadDevices = useCallback(async () => {
    try {
      const deviceType = deviceTypeFilter === 'all' ? undefined : (deviceTypeFilter as DeviceType)
      const bindShell = bindShellFilter === 'all' ? undefined : (bindShellFilter as BindShell)
      const searchTerm = debouncedSearch.trim() || undefined

      const data = await adminApis.getDevices(page, limit, deviceType, bindShell, searchTerm)
      setDevices(data.items)
      setTotal(data.total)
    } catch (error) {
      console.error('Failed to load devices:', error)
      toast.error(t('admin:device_monitor.errors.load_failed'))
    }
  }, [page, deviceTypeFilter, bindShellFilter, debouncedSearch, t])

  const loadData = useCallback(async () => {
    setIsLoading(true)
    await Promise.all([loadStats(), loadDevices()])
    setIsLoading(false)
  }, [loadStats, loadDevices])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await Promise.all([loadStats(), loadDevices()])
    setIsRefreshing(false)
  }, [loadStats, loadDevices])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    setPage(1)
  }, [deviceTypeFilter, bindShellFilter, debouncedSearch])

  // Device action handlers
  const handleUpgrade = useCallback(
    async (device: AdminDeviceInfo) => {
      const key = `${device.device_id}-upgrade`
      if (actionLoading[key]) return

      setActionLoading(prev => ({ ...prev, [key]: 'upgrade' }))
      try {
        const result = await adminApis.upgradeDevice(device.device_id, device.user_id)
        if (result.success) {
          toast.success(t('admin:device_monitor.actions.upgrade_sent'))
        } else {
          toast.error(result.message)
        }
      } catch (error) {
        console.error('Failed to upgrade device:', error)
        toast.error(t('admin:device_monitor.errors.upgrade_failed'))
      } finally {
        setActionLoading(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    },
    [actionLoading, t]
  )

  const handleRestart = useCallback(
    async (device: AdminDeviceInfo) => {
      const key = `${device.device_id}-restart`
      if (actionLoading[key]) return

      setActionLoading(prev => ({ ...prev, [key]: 'restart' }))
      try {
        const result = await adminApis.restartDevice(device.device_id, device.user_id)
        if (result.success) {
          toast.success(t('admin:device_monitor.actions.restart_sent'))
        } else {
          toast.info(result.message)
        }
      } catch (error) {
        console.error('Failed to restart device:', error)
        toast.error(t('admin:device_monitor.errors.restart_failed'))
      } finally {
        setActionLoading(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    },
    [actionLoading, t]
  )

  const handleMigrate = useCallback(
    async (device: AdminDeviceInfo) => {
      const key = `${device.device_id}-migrate`
      if (actionLoading[key]) return

      setActionLoading(prev => ({ ...prev, [key]: 'migrate' }))
      try {
        const result = await adminApis.migrateDevice(device.device_id, device.user_id)
        if (result.success) {
          toast.success(t('admin:device_monitor.actions.migrate_sent'))
        } else {
          toast.info(result.message)
        }
      } catch (error) {
        console.error('Failed to migrate device:', error)
        toast.error(t('admin:device_monitor.errors.migrate_failed'))
      } finally {
        setActionLoading(prev => {
          const next = { ...prev }
          delete next[key]
          return next
        })
      }
    },
    [actionLoading, t]
  )

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">
            {t('admin:device_monitor.title')}
          </h1>
          <p className="text-text-muted text-sm">{t('admin:device_monitor.description')}</p>
        </div>
        <Button variant="outline" size="icon" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
        </Button>
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard
            title={t('admin:device_monitor.stats.total')}
            value={stats.total}
            icon={<Monitor className="h-5 w-5" />}
          />
          <StatCard
            title={t('admin:device_monitor.stats.user_count')}
            value={stats.user_count}
            icon={<Users className="h-5 w-5" />}
          />
          <StatCard
            title={t('admin:device_monitor.stats.online')}
            value={stats.by_status.online ?? 0}
            icon={<Wifi className="h-5 w-5" />}
            variant="success"
          />
          <StatCard
            title={t('admin:device_monitor.stats.offline')}
            value={stats.by_status.offline ?? 0}
            icon={<WifiOff className="h-5 w-5" />}
            variant="error"
          />
          <StatCard
            title={t('admin:device_monitor.stats.local')}
            value={stats.by_device_type.local ?? 0}
            icon={<HardDrive className="h-5 w-5" />}
          />
          <StatCard
            title={t('admin:device_monitor.stats.cloud')}
            value={stats.by_device_type.cloud ?? 0}
            icon={<Cloud className="h-5 w-5" />}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
          <Input
            placeholder={t('admin:device_monitor.search_placeholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10"
            data-testid="device-search-input"
          />
        </div>
        <Select value={deviceTypeFilter} onValueChange={setDeviceTypeFilter}>
          <SelectTrigger className="w-[140px]" data-testid="device-type-filter-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin:device_monitor.filters.all_device_type')}</SelectItem>
            <SelectItem value="local">{t('admin:device_monitor.device_type.local')}</SelectItem>
            <SelectItem value="cloud">{t('admin:device_monitor.device_type.cloud')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={bindShellFilter} onValueChange={setBindShellFilter}>
          <SelectTrigger className="w-[160px]" data-testid="bind-shell-filter-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin:device_monitor.filters.all_bind_shell')}</SelectItem>
            <SelectItem value="claudecode">
              {t('admin:device_monitor.bind_shell.claudecode')}
            </SelectItem>
            <SelectItem value="openclaw">
              {t('admin:device_monitor.bind_shell.openclaw')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Device List */}
      <div className="bg-base border border-border rounded-md p-2 w-full max-h-[50vh] flex flex-col overflow-y-auto">
        {devices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor className="w-12 h-12 text-text-muted mb-4" />
            <p className="text-text-muted">{t('admin:device_monitor.no_devices')}</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-2 p-1">
            {devices.map(device => {
              const isOnline = device.status === 'online'
              const isCloud = device.device_type === 'cloud'
              const canUpgrade =
                isOnline &&
                device.executor_version &&
                isVersionAtLeast(device.executor_version, MIN_AUTO_UPGRADE_VERSION)
              const upgradeKey = `${device.device_id}-upgrade`
              const restartKey = `${device.device_id}-restart`
              const migrateKey = `${device.device_id}-migrate`

              return (
                <Card
                  key={device.id}
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
                          {t('admin:device_monitor.columns.device_id')}: {device.device_id}
                        </span>
                        <span>
                          {t('admin:device_monitor.columns.user')}: {device.user_name}
                        </span>
                        {device.client_ip && (
                          <span>
                            {t('admin:device_monitor.columns.ip')}: {device.client_ip}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Action Buttons */}
                    <div className="flex items-center gap-1 shrink-0">
                      <TooltipProvider>
                        {/* Upgrade Button - available for online devices with version >= 1.6.5 */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={!canUpgrade || !!actionLoading[upgradeKey]}
                              onClick={() => handleUpgrade(device)}
                              data-testid={`upgrade-device-${device.device_id}`}
                            >
                              <ArrowUpCircle
                                className={cn(
                                  'h-4 w-4',
                                  actionLoading[upgradeKey] && 'animate-pulse'
                                )}
                              />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {canUpgrade
                              ? t('admin:device_monitor.actions.upgrade')
                              : t('admin:device_monitor.actions.upgrade_unsupported', {
                                  version: MIN_AUTO_UPGRADE_VERSION,
                                })}
                          </TooltipContent>
                        </Tooltip>

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
                                  className={cn(
                                    'h-4 w-4',
                                    actionLoading[restartKey] && 'animate-spin'
                                  )}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t('admin:device_monitor.actions.restart')}
                            </TooltipContent>
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
                                  className={cn(
                                    'h-4 w-4',
                                    actionLoading[migrateKey] && 'animate-pulse'
                                  )}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {t('admin:device_monitor.actions.migrate')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TooltipProvider>
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-text-muted">
            {t('admin:monitor.error_list.pagination', {
              start: (page - 1) * limit + 1,
              end: Math.min(page * limit, total),
              total,
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-8 px-3"
              data-testid="prev-page-button"
            >
              <ChevronLeftIcon className="w-4 h-4 mr-1" />
              {t('common:common.previous')}
            </Button>
            <span className="text-sm text-text-muted">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-8 px-3"
              data-testid="next-page-button"
            >
              {t('common:common.next')}
              <ChevronRightIcon className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default DeviceMonitorPanel
