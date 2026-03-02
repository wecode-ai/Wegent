// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback } from 'react'
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
import { teamService } from '@/features/tasks/service/teamService'
import { Monitor, WifiOff, X } from 'lucide-react'
import { ChatArea } from '@/features/tasks/components/chat'
import { TaskParamSync, DeviceTaskSync } from '@/features/tasks/components/params'
import { CloudDeviceVncPanel, VncViewer } from '@wecode/components/cloud-device'
import { cloudDeviceApis } from '@wecode/apis'

export default function DeviceChatPage() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { clearAllStreams } = useChatStreamContext()
  const { setSelectedTask, selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail } =
    useTaskContext()
  const isMobile = useIsMobile()

  // Team state from service (needed for ChatArea)
  const { teams, isTeamsLoading, refreshTeams } = teamService.useTeams()

  // Device state
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()

  // Get selected device info
  const selectedDevice = devices.find(d => d.device_id === selectedDeviceId)

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // VNC panel state
  const [isVncOpen, setIsVncOpen] = useState(false)
  const [sandboxId, setSandboxId] = useState<string | null>(null)

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

  // Auto-select first online device if none selected
  useEffect(() => {
    if (!selectedDeviceId && devices.length > 0) {
      const onlineDevice = devices.find(d => d.status === 'online')
      if (onlineDevice) {
        setSelectedDeviceId(onlineDevice.device_id)
      }
    }
  }, [devices, selectedDeviceId, setSelectedDeviceId])

  // Determine if current device is a cloud device
  const isCloudDevice = selectedDevice?.device_type === 'cloud'

  // Fetch sandbox_id when a cloud device is selected
  useEffect(() => {
    if (!isCloudDevice || !selectedDeviceId || selectedDevice?.status === 'offline') {
      setSandboxId(null)
      setIsVncOpen(false)
      return
    }

    let cancelled = false
    cloudDeviceApis
      .getCloudDeviceStatus(selectedDeviceId)
      .then(status => {
        if (!cancelled && status.sandbox_id) {
          setSandboxId(status.sandbox_id)
        }
      })
      .catch(() => {
        // Silently handle - VNC toggle won't show if fetch fails
      })

    return () => {
      cancelled = true
    }
  }, [selectedDeviceId, isCloudDevice, selectedDevice?.status])

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
    // Close VNC panel when switching devices
    setIsVncOpen(false)
  }

  const handleToggleVnc = () => {
    setIsVncOpen(prev => !prev)
  }

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Show VNC panel only when open and device is a cloud device with sandboxId
  const showVncPanel = isVncOpen && sandboxId && selectedDeviceId && !isMobile

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* URL parameter sync for task selection */}
      <TaskParamSync />
      <DeviceTaskSync />

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
        {/* Top navigation with device selector */}
        <TopNavigation
          activePage="devices"
          variant="with-sidebar"
          title={currentTaskTitle || t('device_chat_title') || '设备任务'}
          taskDetail={selectedTaskDetail}
          onMobileSidebarToggle={() => setIsMobileSidebarOpen(true)}
          onTaskDeleted={handleTaskDeleted}
          onMembersChanged={handleMembersChanged}
          isSidebarCollapsed={isCollapsed}
        >
          {/* Device selector in top bar */}
          <div className="flex items-center gap-2 mr-2">
            <Monitor className="w-4 h-4 text-text-muted" />
            <select
              value={selectedDeviceId || ''}
              onChange={e => handleDeviceSelect(e.target.value)}
              className="bg-surface border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="" disabled>
                {t('select_device')}
              </option>
              {devices.map(device => (
                <option key={device.device_id} value={device.device_id}>
                  {device.name} (
                  {device.status === 'online'
                    ? t('status_online')
                    : device.status === 'busy'
                      ? t('status_busy')
                      : t('status_offline')}
                  )
                </option>
              ))}
            </select>
          </div>
          {isCloudDevice && sandboxId && (
            <CloudDeviceVncPanel isVncOpen={isVncOpen} onToggleVnc={handleToggleVnc} />
          )}
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Chat area or placeholder */}
        {selectedDeviceId || selectedTaskDetail ? (
          <div className="flex flex-1 min-h-0">
            {/* Chat area - width adjusts based on VNC panel */}
            <div
              className="transition-all duration-300 ease-in-out flex flex-col min-h-0"
              style={{ width: showVncPanel ? '50%' : '100%' }}
            >
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
            </div>

            {/* VNC Panel */}
            {showVncPanel && (
              <div className="w-1/2 flex flex-col min-h-0 border-l border-border">
                {/* VNC panel header */}
                <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-surface">
                  <h3 className="text-sm font-medium text-text-primary">{t('vnc_panel_title')}</h3>
                  <button
                    onClick={() => setIsVncOpen(false)}
                    className="w-6 h-6 flex items-center justify-center rounded hover:bg-hover text-text-muted hover:text-text-primary transition-colors"
                    title={t('vnc_close')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {/* VNC viewer */}
                <VncViewer deviceId={selectedDeviceId} />
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-base">
            <div className="text-center max-w-md px-6">
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
