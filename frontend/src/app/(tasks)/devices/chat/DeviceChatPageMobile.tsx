// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
import TopNavigation from '@/features/layout/TopNavigation'
import { TaskSidebar } from '@/features/tasks/components/sidebar'
import { ThemeToggle } from '@/features/theme/ThemeToggle'
import { useTranslation } from '@/hooks/useTranslation'
import { saveLastTab } from '@/utils/userPreferences'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { useDevices } from '@/contexts/DeviceContext'
import { teamService } from '@/features/tasks/service/teamService'
import { Monitor, WifiOff } from 'lucide-react'
import { ChatArea } from '@/features/tasks/components/chat'

/**
 * Mobile-specific implementation of Device Chat Page
 *
 * Optimized for screens ≤767px with:
 * - Slide-out drawer sidebar with device selector
 * - Touch-friendly controls (min 44px targets)
 * - Beta badge in top navigation
 * - Simplified navigation
 *
 * @see DeviceChatPageDesktop.tsx for desktop implementation
 */
export function DeviceChatPageMobile() {
  const { t } = useTranslation('devices')
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask, selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail } =
    useTaskContext()

  // Team state from service (needed for ChatArea)
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // Device state
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  useEffect(() => {
    saveLastTab('devices')
  }, [])

  // Auto-select first online device if none selected
  useEffect(() => {
    if (!selectedDeviceId && devices.length > 0) {
      const onlineDevice = devices.find(d => d.status === 'online')
      if (onlineDevice) {
        setSelectedDeviceId(onlineDevice.device_id)
      }
    }
  }, [devices, selectedDeviceId, setSelectedDeviceId])

  // Handle task deletion
  const handleTaskDeleted = useCallback(() => {
    setSelectedTask(null)
    refreshTasks()
  }, [setSelectedTask, refreshTasks])

  // Handle members changed
  const handleMembersChanged = useCallback(() => {
    refreshTasks()
    refreshSelectedTaskDetail(false)
  }, [refreshTasks, refreshSelectedTaskDetail])

  // Handle refresh teams
  const handleRefreshTeams = useCallback(async () => {
    return await refreshTeams()
  }, [refreshTeams])

  // Handle device selection from sidebar
  const handleDeviceSelect = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId)
      // Clear any existing task when selecting a new device
      setSelectedTask(null)
      clearAllStreams()
      // Close sidebar after selection
      setIsMobileSidebarOpen(false)
    },
    [setSelectedDeviceId, setSelectedTask, clearAllStreams]
  )

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Get selected device info
  const selectedDevice = devices.find(d => d.device_id === selectedDeviceId)

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* Mobile sidebar with device selector */}
      <TaskSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        pageType="devices"
        isCollapsed={false}
        onToggleCollapsed={() => {}}
        // Device selection props for mobile
        devices={devices}
        selectedDeviceId={selectedDeviceId}
        onDeviceSelect={handleDeviceSelect}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation - mobile optimized */}
        <TopNavigation
          activePage="devices"
          variant="with-sidebar"
          title={currentTaskTitle || t('device_chat_title') || 'Device Task'}
          titleSuffix={
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
              {t('beta')}
            </span>
          }
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={false}
        >
          <ThemeToggle />
        </TopNavigation>

        {/* Chat area or placeholder */}
        {/* Show ChatArea when device is selected OR when viewing an existing task */}
        {selectedDeviceId || selectedTaskDetail ? (
          <ChatArea
            teams={teams}
            isTeamsLoading={isTeamsLoading}
            showRepositorySelector={false}
            taskType="task"
            onRefreshTeams={handleRefreshTeams}
            disabledReason={
              !selectedDevice || selectedDevice.status === 'offline'
                ? t('device_offline_cannot_send')
                : undefined
            }
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-base">
            <div className="text-center max-w-md px-6">
              {devices.length === 0 ? (
                <>
                  <WifiOff className="w-12 h-12 text-text-muted mx-auto mb-3" />
                  <h3 className="text-base font-semibold text-text-primary mb-2">
                    {t('no_devices')}
                  </h3>
                  <p className="text-sm text-text-muted">{t('instructions')}</p>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center mx-auto mb-3">
                    <Monitor className="w-6 h-6 text-primary" />
                  </div>
                  <h3 className="text-base font-semibold text-text-primary mb-2">
                    {t('select_device')}
                  </h3>
                  <p className="text-sm text-text-muted">{t('select_device_hint')}</p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
