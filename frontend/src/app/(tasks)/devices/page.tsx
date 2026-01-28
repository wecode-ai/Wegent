// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
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
import { Monitor, RefreshCw, WifiOff, Loader2, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export default function DevicesPage() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const isMobile = useIsMobile()

  const { devices, isLoading, error, refreshDevices, setSelectedDeviceId } = useDevices()

  // Handle starting a task with a device
  const handleStartTask = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    setSelectedTask(null)
    clearAllStreams()
    router.push('/devices/chat')
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
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <WifiOff className="w-16 h-16 text-text-muted mb-4" />
                <h3 className="text-lg font-medium text-text-primary mb-2">{t('no_devices')}</h3>
                <p className="text-text-muted max-w-md">{t('instructions')}</p>
              </div>
            )}

            {/* Device list */}
            {devices.length > 0 && (
              <div className="grid gap-4">
                {devices.map(device => (
                  <div
                    key={device.device_id}
                    className="bg-surface border border-border rounded-lg p-4 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                        <Monitor className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <h4 className="font-medium text-text-primary">{device.name}</h4>
                        <p className="text-sm text-text-muted">{device.device_id}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
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
