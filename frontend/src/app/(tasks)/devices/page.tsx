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
import { paths } from '@/config/paths'
import { useDevices } from '@/contexts/DeviceContext'
import { DeviceInfo } from '@/apis/devices'
import { getToken } from '@/apis/user'
import { Monitor, Loader2, Cloud } from 'lucide-react'
import { getSocketUrl } from '@/lib/runtime-config'
import {
  DeviceCard,
  DevicesPageHeader,
  DeviceSection,
  DeviceSetupGuide,
} from '@/features/devices/components'
import { useDeviceHandlers } from '@/features/devices/hooks'

// Helper function to sort devices by priority
function sortDevices(devices: DeviceInfo[]): DeviceInfo[] {
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
}

export default function DevicesPage() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask } = useTaskContext()
  const isMobile = useIsMobile()

  // Environment variables for device setup
  const guideUrl = process.env.NEXT_PUBLIC_DEVICE_GUIDE_URL || ''

  // Generate dynamic backend URL from runtime config
  const backendUrl = useMemo(() => getSocketUrl(), [])

  // Get auth token
  const authToken = useMemo(() => getToken() || '<YOUR_AUTH_TOKEN>', [])

  const { devices, isLoading, error, refreshDevices, isDeviceUpgrading, getUpgradeStatus } = useDevices()

  // Device action handlers (consolidated in custom hook)
  const handlers = useDeviceHandlers()

  // Sort and group devices
  const sortedDevices = useMemo(() => sortDevices(devices), [devices])

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Guide visibility state
  const [showSetupGuide, setShowSetupGuide] = useState(false)

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
            <DevicesPageHeader
              isLoading={isLoading}
              hasDevices={sortedDevices.length > 0}
              onRefresh={refreshDevices}
              onAddDevice={() => setShowSetupGuide(true)}
            />

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

            {/* Device setup guide - shown when no devices or when user clicks Add Device */}
            {(devices.length === 0 || showSetupGuide) && !isLoading && (
              <div className="mb-6">
                <DeviceSetupGuide
                  backendUrl={backendUrl}
                  authToken={authToken}
                  guideUrl={guideUrl}
                />
              </div>
            )}

            {/* Device sections - hide when showing setup guide */}
            {sortedDevices.length > 0 && !showSetupGuide && (
              <div className="space-y-6">
                {/* Local Devices */}
                <DeviceSection
                  title={t('local_devices_section')}
                  icon={Monitor}
                  devices={sortedDevices}
                  type="local"
                  emptyMessage={t('no_local_devices')}
                >
                  {device => (
                    <DeviceCard
                      device={device}
                      onStartTask={handlers.handleStartTask}
                      onSetDefault={handlers.handleSetDefault}
                      onDelete={handlers.handleDeleteDevice}
                      onCancelTask={handlers.handleCancelTask}
                      onUpgrade={handlers.handleUpgradeDevice}
                      isUpgrading={isDeviceUpgrading(device.device_id)}
                      upgradeStatus={getUpgradeStatus(device.device_id)}
                    />
                  )}
                </DeviceSection>

                {/* Cloud Devices */}
                <DeviceSection
                  title={t('cloud_devices_section')}
                  icon={Cloud}
                  devices={sortedDevices}
                  type="cloud"
                  emptyMessage={t('cloud_devices_coming_soon')}
                >
                  {device => (
                    <DeviceCard
                      device={device}
                      onStartTask={handlers.handleStartTask}
                      onSetDefault={handlers.handleSetDefault}
                      onDelete={handlers.handleDeleteDevice}
                      onCancelTask={handlers.handleCancelTask}
                      onUpgrade={handlers.handleUpgradeDevice}
                      isUpgrading={isDeviceUpgrading(device.device_id)}
                      upgradeStatus={getUpgradeStatus(device.device_id)}
                    />
                  )}
                </DeviceSection>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
