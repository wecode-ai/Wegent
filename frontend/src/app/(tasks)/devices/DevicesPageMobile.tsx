// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useTranslation } from '@/hooks/useTranslation'
import { saveLastTab } from '@/utils/userPreferences'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useSocket } from '@/contexts/SocketContext'
import { useDevices } from '@/contexts/DeviceContext'
import { getToken } from '@/apis/user'
import { DeviceInfo } from '@/apis/devices'
import { useDeviceStatusHelpers } from '@/features/devices/hooks'
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
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { getSocketUrl } from '@/lib/runtime-config'
import { LocalExecutorGuide } from '@/features/devices/components/LocalExecutorGuide'

/**
 * Mobile-specific implementation of Devices Page
 *
 * Optimized for screens ≤767px with:
 * - Slide-out drawer sidebar
 * - Simplified device cards (name + status only)
 * - Touch-friendly controls (min 44px targets)
 * - Beta badge in header
 *
 * @see DevicesPageDesktop.tsx for desktop implementation
 */
export function DevicesPageMobile() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const { closeTaskSession } = useSocket()

  // Device status helpers
  const { getStatusColor, getStatusText } = useDeviceStatusHelpers()

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

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Handle cancelling/closing a task via WebSocket
  const _handleCancelTask = useCallback(
    async (taskId: number) => {
      try {
        const result = await closeTaskSession(taskId)
        if (result.success) {
          toast.success(t('close_session_success'))
          await refreshDevices()
        } else {
          toast.error(result.error || t('close_session_error'))
        }
      } catch (error) {
        console.error('Failed to close task session:', error)
        toast.error(t('close_session_error'))
      }
    },
    [closeTaskSession, refreshDevices, t]
  )

  // Sort devices: online first, then by default status, then by name
  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      const statusOrder: Record<string, number> = { online: 0, busy: 1, offline: 2 }
      const statusDiff = (statusOrder[a.status] ?? 2) - (statusOrder[b.status] ?? 2)
      if (statusDiff !== 0) return statusDiff
      if (a.is_default && !b.is_default) return -1
      if (!a.is_default && b.is_default) return 1
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

  useEffect(() => {
    saveLastTab('devices')
  }, [])

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Mobile sidebar */}
      <TaskSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        pageType="devices"
        isCollapsed={false}
        onToggleCollapsed={() => {}}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation - mobile optimized */}
        <TopNavigation
          activePage="devices"
          variant="with-sidebar"
          title={t('title')}
          titleSuffix={
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
              {t('beta')}
            </span>
          }
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          isSidebarCollapsed={false}
        >
          <ThemeToggle />
        </TopNavigation>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-4">
          <div className="max-w-4xl mx-auto">
            {/* Header with refresh button - simplified for mobile */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Monitor className="w-5 h-5 text-primary" />
                <h2 className="text-base font-semibold">{t('title')}</h2>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshDevices}
                disabled={isLoading}
                className="h-11 min-w-[44px] px-3"
              >
                <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
                <span className="sr-only">{t('refresh')}</span>
              </Button>
            </div>

            {/* Instructions - condensed for mobile */}
            <p className="text-text-muted text-sm mb-4">{t('instructions')}</p>

            {/* Error message */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg mb-4 text-sm">
                {error}
              </div>
            )}

            {/* Loading state */}
            {isLoading && devices.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-text-muted" />
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

                {/* Help section - simplified for mobile */}
                {(communityUrl || faqUrl) && (
                  <div className="flex flex-col items-center gap-3 text-sm text-text-muted">
                    <span>{t('need_help')}</span>
                    <div className="flex gap-4">
                      {communityUrl && (
                        <a
                          href={communityUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-text-secondary hover:text-primary transition-colors h-11 min-w-[44px] px-2"
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
                          className="inline-flex items-center gap-1.5 text-text-secondary hover:text-primary transition-colors h-11 min-w-[44px] px-2"
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

            {/* Device list - simplified cards for mobile */}
            {sortedDevices.length > 0 && (
              <div className="grid gap-3">
                {sortedDevices.map(device => (
                  <div
                    key={device.device_id}
                    className={cn(
                      'bg-surface border rounded-lg p-4',
                      device.is_default ? 'border-primary' : 'border-border'
                    )}
                  >
                    {/* Device info row - simplified for mobile */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                          <Monitor className="w-5 h-5 text-primary" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <h4 className="font-medium text-text-primary truncate">{device.name}</h4>
                            {device.is_default && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full flex-shrink-0">
                                <Star className="w-3 h-3 fill-current" />
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-sm text-text-muted">
                            <span
                              className={cn(
                                'w-2 h-2 rounded-full flex-shrink-0',
                                getStatusColor(device.status)
                              )}
                            />
                            <span>{getStatusText(device.status)}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleStartTask(device.device_id)}
                          disabled={
                            device.status !== 'online' || device.slot_used >= device.slot_max
                          }
                          className="h-11 min-w-[44px] px-3"
                        >
                          <Play className="w-4 h-4" />
                          <span className="sr-only">
                            {device.slot_used >= device.slot_max ? t('slots_full') : t('start_task')}
                          </span>
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-11 w-11 p-0">
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
