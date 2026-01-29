// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useMemo } from 'react'
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
import { paths } from '@/config/paths'
import { useDevices } from '@/contexts/DeviceContext'
import { DeviceInfo } from '@/apis/devices'
import {
  Monitor,
  RefreshCw,
  Loader2,
  Play,
  Star,
  MoreVertical,
  Trash2,
  Copy,
  Check,
  ExternalLink,
  Terminal,
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

export default function DevicesPage() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const isMobile = useIsMobile()

  // Environment variables for device setup
  const installCommand = process.env.NEXT_PUBLIC_DEVICE_INSTALL_COMMAND || ''
  const guideUrl = process.env.NEXT_PUBLIC_DEVICE_GUIDE_URL || ''
  const communityUrl = process.env.NEXT_PUBLIC_COMMUNITY_URL || ''
  const faqUrl = process.env.NEXT_PUBLIC_FAQ_URL || ''

  // Copy state for install command
  const [copied, setCopied] = useState(false)

  const handleCopyCommand = async () => {
    if (!installCommand) return
    try {
      await navigator.clipboard.writeText(installCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  const {
    devices,
    isLoading,
    error,
    refreshDevices,
    setSelectedDeviceId,
    setDefaultDevice,
    deleteDevice,
  } = useDevices()

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
  const handleStartTask = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    setSelectedTask(null)
    clearAllStreams()
    router.push('/devices/chat')
  }

  // Handle setting a device as default
  const handleSetDefault = async (device: DeviceInfo) => {
    try {
      await setDefaultDevice(device.device_id)
      toast.success(t('set_default_success', { name: device.name }))
    } catch {
      toast.error(t('set_default_error'))
    }
  }

  // Handle deleting a device
  const handleDeleteDevice = async (device: DeviceInfo) => {
    try {
      await deleteDevice(device.device_id)
      toast.success(t('delete_success', { name: device.name }))
    } catch {
      toast.error(t('delete_error'))
    }
  }

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

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    setSelectedTask(null)
    clearAllStreams()
    router.replace(paths.chat.getHref())
  }

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

            {/* Empty state */}
            {!isLoading && devices.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8">
                {/* Main card */}
                <div className="w-full max-w-2xl bg-surface border border-border rounded-xl p-6 shadow-sm">
                  {/* Header */}
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                      <Terminal className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-text-primary">
                        {t('one_step_title')}
                      </h3>
                      <p className="text-sm text-text-muted">{t('one_step_description')}</p>
                    </div>
                  </div>

                  {/* Command box */}
                  {installCommand && (
                    <>
                      {/* Command box with dark theme */}
                      <div className="bg-gray-900 rounded-lg px-5 py-4 mt-5">
                        <div className="flex items-center gap-3">
                          <span className="text-gray-500 select-none">$</span>
                          <div className="flex-1 overflow-x-auto">
                            <code className="text-sm font-mono whitespace-nowrap text-green-400">
                              {installCommand}
                            </code>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCopyCommand}
                            className="shrink-0 text-gray-400 hover:text-white hover:bg-gray-800 h-8 px-3"
                          >
                            {copied ? (
                              <Check className="w-4 h-4 text-green-400" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Guide link */}
                  {guideUrl && (
                    <div className="mt-4 flex justify-center">
                      <a
                        href={guideUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                      >
                        <ExternalLink className="w-4 h-4" />
                        {t('view_guide')}
                      </a>
                    </div>
                  )}
                </div>

                {/* Help section */}
                {(communityUrl || faqUrl) && (
                  <div className="mt-6 flex items-center gap-4 text-sm text-text-muted">
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
                )}
              </div>
            )}

            {/* Device list */}
            {sortedDevices.length > 0 && (
              <div className="grid gap-4">
                {sortedDevices.map(device => (
                  <div
                    key={device.device_id}
                    className={cn(
                      'bg-surface border rounded-lg p-4 flex items-center justify-between',
                      device.is_default ? 'border-primary' : 'border-border'
                    )}
                  >
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
                        <p className="text-sm text-text-muted">{device.device_id}</p>
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
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleStartTask(device.device_id)}
                        disabled={device.status !== 'online'}
                        className="flex items-center gap-2"
                      >
                        <Play className="w-4 h-4" />
                        {t('start_task')}
                      </Button>
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
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
