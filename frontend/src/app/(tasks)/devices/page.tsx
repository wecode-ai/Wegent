// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import {
  TaskSidebar,
  ResizableSidebar,
  CollapsedSidebarButtons,
} from '@/features/tasks/components/sidebar'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useTranslation } from '@/hooks/useTranslation'
import { saveLastTab } from '@/utils/userPreferences'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useSocket } from '@/contexts/SocketContext'
import { paths } from '@/config/paths'
import { useDevices } from '@/contexts/DeviceContext'
import { getToken } from '@/apis/user'
import { DeviceInfo } from '@/apis/devices'
import { SlotIndicator } from '@/features/devices/components/SlotIndicator'
import { RunningTasksList } from '@/features/devices/components/RunningTasksList'
import { VersionBadge } from '@/features/devices/components/VersionBadge'
import {
  Monitor,
  RefreshCw,
  Loader2,
  Play,
  Star,
  MoreVertical,
  Trash2,
  ExternalLink,
  MessageCircleQuestion,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { getSocketUrl } from '@/lib/runtime-config'
import { LocalExecutorGuide } from '@/features/devices/components/LocalExecutorGuide'

export default function DevicesPage() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const { closeTaskSession } = useSocket()
  const isMobile = useIsMobile()

  // Environment variables for device setup
  const guideUrl = process.env.NEXT_PUBLIC_DEVICE_GUIDE_URL || ''
  const communityUrl = process.env.NEXT_PUBLIC_COMMUNITY_URL || ''
  const faqUrl = process.env.NEXT_PUBLIC_FAQ_URL || ''

  // Generate dynamic backend URL from runtime config
  const backendUrl = useMemo(() => getSocketUrl(), [])

  // Get auth token
  const authToken = useMemo(() => getToken() || '<YOUR_AUTH_TOKEN>', [])

  const {
    devices,
    isLoading,
    error,
    refreshDevices,
    setSelectedDeviceId,
    setDefaultDevice,
    deleteDevice,
  } = useDevices()

  // Handle cancelling/closing a task via WebSocket
  // For running tasks: pauses execution
  // For completed tasks: closes session and frees device slot
  const handleCancelTask = async (taskId: number) => {
    try {
      const result = await closeTaskSession(taskId)
      if (result.success) {
        toast.success(t('close_session_success'))
        // Refresh devices to update slot usage
        await refreshDevices()
      } else {
        toast.error(result.error || t('close_session_error'))
      }
    } catch (error) {
      console.error('Failed to close task session:', error)
      toast.error(t('close_session_error'))
    }
  }

  // Sort devices: online first, then by default status, then by name
  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      // Priority 1: Online devices first (online > busy > offline)
      const statusOrder: Record<string, number> = { online: 0, busy: 1, offline: 2 }
      const statusDiff = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2)
      if (statusDiff !== 0) return statusDiff

      // Priority 2: Default device first
      if (a.is_default && !b.is_default) return -1
      if (!a.is_default && b.is_default) return 1

      // Priority 3: Alphabetically by name
      return a.name.localeCompare(b.name)
    })
  }, [devices])

  // Handle starting a task with a device
  const handleStartTask = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId)
      setSelectedTask(null)
      clearAllStreams()
      router.push('/devices/chat')
    },
    [setSelectedDeviceId, setSelectedTask, clearAllStreams, router]
  )

  // Handle setting a device as default
  const handleSetDefault = useCallback(
    async (device: DeviceInfo) => {
      try {
        await setDefaultDevice(device.device_id)
        toast.success(t('set_default_success', { name: device.name }))
      } catch {
        toast.error(t('set_default_error'))
      }
    },
    [setDefaultDevice, t]
  )

  // Handle deleting a device
  const handleDeleteDevice = useCallback(
    async (device: DeviceInfo) => {
      try {
        await deleteDevice(device.device_id)
        toast.success(t('delete_success', { name: device.name }))
      } catch {
        toast.error(t('delete_error'))
      }
    },
    [deleteDevice, t]
  )

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Load collapsed state from localStorage
  useEffect(() => {
    const savedCollapsed = localStorage.getItem('task-sidebar-collapsed')
    if (savedCollapsed === 'true') {
      setIsCollapsed(true)
    }
  }, [])

  useEffect(() => {
    saveLastTab('devices')
  }, [])

  const handleToggleCollapsed = useCallback(() => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }, [])

  // Handle new task from collapsed sidebar button
  const handleNewTask = useCallback(() => {
    setSelectedTask(null)
    clearAllStreams()
    router.replace(paths.chat.getHref())
  }, [setSelectedTask, clearAllStreams, router])

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
        return t('status_online')
      case 'busy':
        return t('status_busy')
      default:
        return t('status_offline')
    }
  }

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Collapsed sidebar floating buttons */}
      {isCollapsed && !isMobile && (
        <CollapsedSidebarButtons onExpand={handleToggleCollapsed} onNewTask={handleNewTask} />
      )}

      {/* Responsive resizable sidebar */}
      <ResizableSidebar isCollapsed={isCollapsed} onToggleCollapsed={handleToggleCollapsed}>
        <TaskSidebar
          isMobileSidebarOpen={isMobileSidebarOpen}
          setIsMobileSidebarOpen={setIsMobileSidebarOpen}
          pageType="devices"
          isCollapsed={isCollapsed}
          onToggleCollapsed={handleToggleCollapsed}
        />
      </ResizableSidebar>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation */}
        <TopNavigation
          activePage="devices"
          variant="with-sidebar"
          title={t('title')}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={isCollapsed}
        >
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-4xl mx-auto">
            {/* Header with refresh button */}
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <Monitor className="w-6 h-6 text-primary" />
                <h2 className="text-lg font-semibold">{t('title')}</h2>
                <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
                  {t('beta')}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshDevices}
                disabled={isLoading}
                className="flex items-center gap-2"
              >
                <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
                {t('refresh')}
              </Button>
            </div>

            {/* Instructions */}
            <p className="text-text-muted text-sm mb-6">{t('instructions')}</p>

            {/* Error message */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg mb-6">
                {error}
              </div>
            )}

            {/* Loading state */}
            {isLoading && devices.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-text-muted" />
              </div>
            )}

            {/* Empty state with installation guide */}
            {!isLoading && devices.length === 0 && (
              <>
                <LocalExecutorGuide
                  backendUrl={backendUrl}
                  authToken={authToken}
                  guideUrl={guideUrl}
                />

                {/* Help section */}
                {(communityUrl || faqUrl) && (
                  <div className="flex justify-center">
                    <div className="flex items-center gap-4 text-sm text-text-muted">
                      <span>{t('need_help')}</span>
                      {communityUrl && (
                        <a
                          href={communityUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-text-secondary hover:text-primary transition-colors"
                        >
                          <MessageCircleQuestion className="w-4 h-4" />
                          {t('join_community')}
                        </a>
                      )}
                      {faqUrl && (
                        <a
                          href={faqUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-text-secondary hover:text-primary transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                          {t('view_faq')}
                        </a>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Device list */}
            {sortedDevices.length > 0 && (
              <div className="grid gap-4">
                {sortedDevices.map(device => (
                  <div
                    key={device.device_id}
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
                          </div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm text-text-muted">{device.device_id}</p>
                            {device.status !== 'offline' && (
                              <VersionBadge
                                executorVersion={device.executor_version}
                                latestVersion={device.latest_version}
                                updateAvailable={device.update_available}
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
                          <span
                            className={cn('w-2 h-2 rounded-full', getStatusColor(device.status))}
                          />
                          <span className="text-sm text-text-secondary">
                            {getStatusText(device.status)}
                          </span>
                        </div>
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div>
                                <Button
                                  variant="default"
                                  size="sm"
                                  onClick={() => handleStartTask(device.device_id)}
                                  disabled={
                                    device.status !== 'online' ||
                                    device.slot_used >= device.slot_max
                                  }
                                  className="flex items-center gap-2"
                                >
                                  <Play className="w-4 h-4" />
                                  {device.slot_used >= device.slot_max
                                    ? t('slots_full')
                                    : t('start_task')}
                                </Button>
                              </div>
                            </TooltipTrigger>
                            {device.slot_used >= device.slot_max && device.status === 'online' && (
                              <TooltipContent>
                                <p className="text-sm">{t('slots_full_hint')}</p>
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
                              <DropdownMenuItem onClick={() => handleSetDefault(device)}>
                                <Star className="w-4 h-4 mr-2" />
                                {t('set_as_default')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem danger onClick={() => handleDeleteDevice(device)}>
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
                        onCancelTask={handleCancelTask}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
