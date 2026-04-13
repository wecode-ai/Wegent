// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  adminApis,
  AdminDeviceInfo,
  AdminDeviceStats,
  DeviceStatus,
  DeviceType,
  BindShell,
  VersionFilterOperator,
} from '@/apis/admin'
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
  Loader2,
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
import { useSocket } from '@/contexts/SocketContext'
import { DeviceUpgradeStatusPayload, ServerEvents } from '@/types/socket'
import { cn, isCompleteVersionString, isVersionAtLeast } from '@/lib/utils'

// Minimum version required for auto-upgrade support
const MIN_AUTO_UPGRADE_VERSION = '1.6.5'
const FILTER_DEBOUNCE_MS = 600
const TERMINAL_UPGRADE_STATUSES = ['success', 'error', 'skipped'] as const

interface DeviceUpgradeState {
  status: DeviceUpgradeStatusPayload['status']
  message: string
  progress?: number
}

function isTerminalUpgradeStatus(status: DeviceUpgradeStatusPayload['status']) {
  return TERMINAL_UPGRADE_STATUSES.includes(
    status as (typeof TERMINAL_UPGRADE_STATUSES)[number]
  )
}

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
  const { socket, isConnected } = useSocket()
  const [stats, setStats] = useState<AdminDeviceStats | null>(null)
  const [devices, setDevices] = useState<AdminDeviceInfo[]>([])
  const [total, setTotal] = useState(0)
  const [hasLoadedStats, setHasLoadedStats] = useState(false)
  const [hasLoadedDevices, setHasLoadedDevices] = useState(false)
  const [isStatsLoading, setIsStatsLoading] = useState(false)
  const [isDevicesLoading, setIsDevicesLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({})
  const latestDevicesRequestRef = useRef(0)
  const [upgradeStates, setUpgradeStates] = useState<Record<string, DeviceUpgradeState>>({})
  const upgradeClearTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Filter states
  const [deviceTypeFilter, setDeviceTypeFilter] = useState<string>('all')
  const [bindShellFilter, setBindShellFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [versionFilterOp, setVersionFilterOp] = useState<VersionFilterOperator>('lt')
  const [versionFilter, setVersionFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [appliedVersionFilter, setAppliedVersionFilter] = useState('')
  const [page, setPage] = useState(1)
  const limit = 20

  useEffect(() => {
    if (statusFilter === 'offline' && versionFilter) {
      setVersionFilter('')
    }
  }, [statusFilter, versionFilter])

  const applySearchFilter = useCallback(() => {
    setPage(1)
    setDebouncedSearch(search.trim())
  }, [search])

  const applyVersionFilter = useCallback(() => {
    const normalizedVersion = versionFilter.trim()

    if (!normalizedVersion) {
      setPage(1)
      setAppliedVersionFilter('')
      return
    }

    if (!isCompleteVersionString(normalizedVersion)) {
      return
    }

    setPage(1)
    setAppliedVersionFilter(normalizedVersion)
  }, [versionFilter])

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      applySearchFilter()
    }, FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [applySearchFilter])

  useEffect(() => {
    const timer = setTimeout(() => {
      applyVersionFilter()
    }, FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [applyVersionFilter])

  const loadStats = useCallback(async () => {
    setIsStatsLoading(true)
    try {
      const data = await adminApis.getDeviceStats()
      setStats(data)
    } catch (error) {
      console.error('Failed to load device stats:', error)
      toast.error(t('admin:device_monitor.errors.load_stats_failed'))
    } finally {
      setIsStatsLoading(false)
      setHasLoadedStats(true)
    }
  }, [t])

  const loadDevices = useCallback(async () => {
    const requestId = latestDevicesRequestRef.current + 1
    latestDevicesRequestRef.current = requestId
    setIsDevicesLoading(true)

    try {
      const deviceType = deviceTypeFilter === 'all' ? undefined : (deviceTypeFilter as DeviceType)
      const bindShell = bindShellFilter === 'all' ? undefined : (bindShellFilter as BindShell)
      const status = statusFilter === 'all' ? undefined : (statusFilter as DeviceStatus)
      const searchTerm = debouncedSearch.trim() || undefined
      const version = statusFilter === 'offline' ? undefined : appliedVersionFilter || undefined

      const data = await adminApis.getDevices(
        page,
        limit,
        status,
        deviceType,
        bindShell,
        searchTerm,
        version ? versionFilterOp : undefined,
        version
      )
      if (requestId !== latestDevicesRequestRef.current) {
        return
      }
      setDevices(data.items)
      setTotal(data.total)
    } catch (error) {
      if (requestId !== latestDevicesRequestRef.current) {
        return
      }
      console.error('Failed to load devices:', error)
      toast.error(t('admin:device_monitor.errors.load_failed'))
    } finally {
      if (requestId === latestDevicesRequestRef.current) {
        setIsDevicesLoading(false)
        setHasLoadedDevices(true)
      }
    }
  }, [
    page,
    statusFilter,
    deviceTypeFilter,
    bindShellFilter,
    debouncedSearch,
    appliedVersionFilter,
    versionFilterOp,
    t,
  ])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    await Promise.all([loadStats(), loadDevices()])
    setIsRefreshing(false)
  }, [loadStats, loadDevices])

  const clearUpgradeState = useCallback((deviceId: string) => {
    const timer = upgradeClearTimersRef.current[deviceId]
    if (timer) {
      clearTimeout(timer)
      delete upgradeClearTimersRef.current[deviceId]
    }

    setUpgradeStates(prev => {
      if (!prev[deviceId]) return prev

      const next = { ...prev }
      delete next[deviceId]
      return next
    })
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  const isInitialLoading = !hasLoadedStats || !hasLoadedDevices

  useEffect(() => {
    if (!socket || !isConnected) return

    const handleDeviceUpgradeStatus = (data: DeviceUpgradeStatusPayload) => {
      setUpgradeStates(prev => ({
        ...prev,
        [data.device_id]: {
          status: data.status,
          message: data.message,
          progress: data.progress,
        },
      }))

      if (isTerminalUpgradeStatus(data.status)) {
        const existingTimer = upgradeClearTimersRef.current[data.device_id]
        if (existingTimer) {
          clearTimeout(existingTimer)
        }

        upgradeClearTimersRef.current[data.device_id] = setTimeout(() => {
          void Promise.all([loadStats(), loadDevices()])
          clearUpgradeState(data.device_id)
        }, 5000)
      }
    }

    socket.on(ServerEvents.DEVICE_UPGRADE_STATUS, handleDeviceUpgradeStatus)

    return () => {
      socket.off(ServerEvents.DEVICE_UPGRADE_STATUS, handleDeviceUpgradeStatus)
    }
  }, [socket, isConnected, loadStats, loadDevices, clearUpgradeState])

  useEffect(() => {
    return () => {
      Object.values(upgradeClearTimersRef.current).forEach(clearTimeout)
      upgradeClearTimersRef.current = {}
    }
  }, [])

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

  if (isInitialLoading) {
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
          <RefreshCw
            className={cn('h-4 w-4', (isRefreshing || isStatsLoading) && 'animate-spin')}
          />
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
      <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap">
        <div className="relative flex-1 lg:min-w-[280px]">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-text-muted" />
          <Input
            placeholder={t('admin:device_monitor.search_placeholder')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-10"
            data-testid="device-search-input"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={value => {
            setPage(1)
            setStatusFilter(value)
          }}
        >
          <SelectTrigger className="w-full sm:w-[140px]" data-testid="device-status-filter-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin:device_monitor.filters.all_status')}</SelectItem>
            <SelectItem value="online">{t('admin:device_monitor.status.online')}</SelectItem>
            <SelectItem value="offline">{t('admin:device_monitor.status.offline')}</SelectItem>
            <SelectItem value="busy">{t('admin:device_monitor.status.busy')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={deviceTypeFilter}
          onValueChange={value => {
            setPage(1)
            setDeviceTypeFilter(value)
          }}
        >
          <SelectTrigger className="w-full sm:w-[140px]" data-testid="device-type-filter-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('admin:device_monitor.filters.all_device_type')}</SelectItem>
            <SelectItem value="local">{t('admin:device_monitor.device_type.local')}</SelectItem>
            <SelectItem value="cloud">{t('admin:device_monitor.device_type.cloud')}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={bindShellFilter}
          onValueChange={value => {
            setPage(1)
            setBindShellFilter(value)
          }}
        >
          <SelectTrigger className="w-full sm:w-[160px]" data-testid="bind-shell-filter-select">
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
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Select
            value={versionFilterOp}
            onValueChange={value => {
              setPage(1)
              setVersionFilterOp(value as VersionFilterOperator)
            }}
            disabled={statusFilter === 'offline'}
          >
            <SelectTrigger
              className="w-full sm:w-[120px]"
              data-testid="version-operator-filter-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gte">
                {t('admin:device_monitor.version_filter.operators.gte')}
              </SelectItem>
              <SelectItem value="gt">
                {t('admin:device_monitor.version_filter.operators.gt')}
              </SelectItem>
              <SelectItem value="eq">
                {t('admin:device_monitor.version_filter.operators.eq')}
              </SelectItem>
              <SelectItem value="lt">
                {t('admin:device_monitor.version_filter.operators.lt')}
              </SelectItem>
              <SelectItem value="lte">
                {t('admin:device_monitor.version_filter.operators.lte')}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            placeholder={t('admin:device_monitor.version_filter.placeholder')}
            value={versionFilter}
            onChange={e => setVersionFilter(e.target.value)}
            className="w-full sm:w-[220px]"
            data-testid="version-filter-input"
            disabled={statusFilter === 'offline'}
          />
        </div>
      </div>

      {/* Device List */}
      <div
        className="relative bg-base border border-border rounded-md p-2 w-full max-h-[50vh] flex flex-col overflow-y-auto"
        aria-busy={isDevicesLoading}
      >
        {isDevicesLoading && (
          <div
            className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-md border border-border bg-base/95 px-2 py-1 text-xs text-text-muted backdrop-blur-sm"
            data-testid="device-list-loading"
          >
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>{t('admin:device_monitor.loading')}</span>
          </div>
        )}
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
              const isClaudeCode = device.bind_shell === 'claudecode'
              const upgradeState = upgradeStates[device.device_id]
              const isUpgradeInProgress = !!upgradeState
              const canUpgrade =
                isOnline &&
                isClaudeCode &&
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
                        {device.created_at && (
                          <span>
                            {t('admin:device_monitor.columns.created_at')}:{' '}
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
                        {isClaudeCode && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={
                                  !canUpgrade || !!actionLoading[upgradeKey] || isUpgradeInProgress
                                }
                                onClick={() => handleUpgrade(device)}
                                data-testid={`upgrade-device-${device.device_id}`}
                              >
                                <ArrowUpCircle
                                  className={cn(
                                    'h-4 w-4',
                                    (actionLoading[upgradeKey] || isUpgradeInProgress) &&
                                      'animate-pulse'
                                  )}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {isUpgradeInProgress
                                ? upgradeState.message
                                : canUpgrade
                                ? t('admin:device_monitor.actions.upgrade')
                                : t('admin:device_monitor.actions.upgrade_unsupported', {
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
