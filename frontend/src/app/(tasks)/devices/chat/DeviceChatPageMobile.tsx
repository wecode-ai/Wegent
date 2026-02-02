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
import { Monitor } from 'lucide-react'
import { ChatArea } from '@/features/tasks/components/chat'
import { TaskParamSync, DeviceTaskSync } from '@/features/tasks/components/params'
import { WifiOff } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Mobile-specific implementation of Device Chat Page
 *
 * Optimized for screens ≤767px with:
 * - Slide-out drawer sidebar
 * - Touch-friendly controls (min 44px targets)
 * - Compact device selector
 * - Mobile-optimized spacing
 * - Beta badge in TopNavigation
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
  const handleTaskDeleted = () => {
    setSelectedTask(null)
    refreshTasks()
  }

  // Handle members changed
  const handleMembersChanged = () => {
    refreshTasks()
    refreshSelectedTaskDetail(false)
  }

  // Handle refresh teams
  const handleRefreshTeams = useCallback(async () => {
    return await refreshTeams()
  }, [refreshTeams])

  // Handle device selection
  const handleDeviceSelect = (deviceId: string) => {
    setSelectedDeviceId(deviceId)
    // Clear any existing task when selecting a new device
    setSelectedTask(null)
    clearAllStreams()
  }

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Get selected device info
  const selectedDevice = devices.find(d => d.device_id === selectedDeviceId)

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* URL parameter sync for task selection */}
      <TaskParamSync />
      <DeviceTaskSync />

      {/* Mobile sidebar - use TaskSidebar's built-in MobileSidebar component */}
      <TaskSidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        pageType="devices"
        isCollapsed={false}
        onToggleCollapsed={() => {}}
      />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top navigation with device selector - mobile optimized */}
        <TopNavigation
          activePage="devices"
          variant="with-sidebar"
          title={currentTaskTitle || t('device_chat_title') || '设备任务'}
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={false}
        >
          {/* Device selector - compact for mobile with touch-friendly controls */}
          <div className="flex items-center gap-2 mr-2">
            <Monitor className="w-4 h-4 text-text-muted" />
            <Select value={selectedDeviceId || ''} onValueChange={handleDeviceSelect}>
              <SelectTrigger className="h-11 min-w-[44px] w-[180px] text-sm">
                <SelectValue placeholder={t('select_device')} />
              </SelectTrigger>
              <SelectContent>
                {devices.map(device => (
                  <SelectItem key={device.device_id} value={device.device_id}>
                    {device.name} (
                    {device.status === 'online'
                      ? t('status_online')
                      : device.status === 'busy'
                        ? t('status_busy')
                        : t('status_offline')}
                    )
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Beta badge */}
          <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full mr-2">
            {t('beta')}
          </span>
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
          <div className="flex-1 flex items-center justify-center bg-base px-4">
            <div className="text-center max-w-md">
              {devices.length === 0 ? (
                <>
                  <WifiOff className="w-16 h-16 text-text-muted mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-text-primary mb-2">
                    {t('no_devices')}
                  </h3>
                  <p className="text-sm text-text-muted">{t('instructions')}</p>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <Monitor className="w-8 h-8 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold text-text-primary mb-2">
                    {t('select_device')}
                  </h3>
                  <p className="text-sm text-text-muted">
                    {t('select_device_hint') || '从顶部选择一个在线设备开始发送任务'}
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
