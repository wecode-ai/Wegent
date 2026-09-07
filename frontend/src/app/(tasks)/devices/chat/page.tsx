// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import { paths } from '@/config/paths'
import { useDevices } from '@/contexts/DeviceContext'
import { useTeamContext } from '@/contexts/TeamContext'
import { Monitor, WifiOff } from 'lucide-react'
import { TaskParamSync, DeviceParamSync } from '@/features/tasks/components/params'
import { isOpenClawDevice } from '@/features/devices/utils/device-status'
import {
  getAccountDefaultDeviceId,
  resolveDeviceSelectionId,
} from '@/features/devices/utils/execution-target'
import {
  filterDevicesByAdvancedMode,
  resolveOrdinaryDeviceChatTarget,
} from '@/features/devices/utils/device-visibility'
import { useAdvancedDeviceMode } from '@/features/devices/hooks/useAdvancedDeviceMode'
import { useProjectContext } from '@/features/projects/contexts/projectContext'
import { useUser } from '@/features/common/UserContext'

const ChatArea = dynamic(() => import('@/features/tasks/components/chat/ChatArea'), {
  ssr: false,
})

export default function DeviceChatPage() {
  const { t } = useTranslation('devices')
  const router = useRouter()
  const { selectTask, selectedTaskDetail, refreshTasks, refreshSelectedTaskDetail } =
    useTaskSession()
  const isMobile = useIsMobile()

  // Team state from context (centralized to avoid duplicate API calls)
  const { teams, isTeamsLoading, refreshTeams } = useTeamContext()

  // Device state
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevices()
  const { user } = useUser()

  // Check if deviceId is specified in URL
  const searchParams = useSearchParams()
  const routeDeviceId = searchParams.get('deviceId') || searchParams.get('device_id')
  const hasDeviceIdParam = Boolean(routeDeviceId)
  const routeTaskId =
    searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')
  const isExistingTask = Boolean(routeTaskId)
  const selectedTaskMatchesRoute = isExistingTask && String(selectedTaskDetail?.id) === routeTaskId

  // Project context — when projectId is in URL, device is locked to project config
  const projectIdParam = searchParams.get('projectId')
  const projectId = projectIdParam ? Number(projectIdParam) : null
  const { projects } = useProjectContext()
  const activeProject = useMemo(() => {
    if (!projectId) return null
    return projects.find(p => p.id === projectId) ?? null
  }, [projectId, projects])
  const isProjectContext = !!activeProject
  const { showAdvancedDevices, isAdvancedDeviceModeReady } = useAdvancedDeviceMode()

  const persistedTaskDeviceId =
    selectedTaskMatchesRoute && selectedTaskDetail?.task_type === 'task'
      ? selectedTaskDetail.device_id || null
      : null
  const visibleDevices = useMemo(
    () => filterDevicesByAdvancedMode(devices, showAdvancedDevices),
    [devices, showAdvancedDevices]
  )
  const conversationDevices = useMemo(() => {
    const pinnedDeviceId = resolveDeviceSelectionId(
      devices,
      isExistingTask ? persistedTaskDeviceId : routeDeviceId
    )
    const pinnedDevice = pinnedDeviceId
      ? devices.find(device => device.device_id === pinnedDeviceId)
      : undefined

    if (!pinnedDevice || visibleDevices.some(device => device.device_id === pinnedDeviceId)) {
      return visibleDevices
    }
    return [...visibleDevices, pinnedDevice]
  }, [devices, isExistingTask, persistedTaskDeviceId, routeDeviceId, visibleDevices])

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

  // Ordinary device conversations prefer Executor devices. Explicit device
  // links and existing tasks keep their exact persisted target.
  useEffect(() => {
    if (hasDeviceIdParam || isExistingTask || !isAdvancedDeviceModeReady) return
    const defaultDeviceId = resolveDeviceSelectionId(
      devices,
      getAccountDefaultDeviceId(user?.preferences?.default_execution_target)
    )
    const nextDeviceId = resolveOrdinaryDeviceChatTarget(devices, selectedDeviceId, defaultDeviceId)
    if (selectedDeviceId !== nextDeviceId) setSelectedDeviceId(nextDeviceId)
  }, [
    devices,
    hasDeviceIdParam,
    isAdvancedDeviceModeReady,
    isExistingTask,
    selectedDeviceId,
    setSelectedDeviceId,
    user,
  ])

  const handleToggleCollapsed = () => {
    setIsCollapsed(prev => {
      const newValue = !prev
      localStorage.setItem('task-sidebar-collapsed', String(newValue))
      return newValue
    })
  }

  // Handle new task from collapsed sidebar button
  const handleNewTask = () => {
    selectTask(null)
    router.replace(paths.chat.getHref())
  }

  // Handle task deletion
  const handleTaskDeleted = () => {
    selectTask(null)
    refreshTasks()
  }

  // Handle members changed
  const handleMembersChanged = () => {
    refreshTasks()
    void refreshSelectedTaskDetail()
  }

  // Handle refresh teams
  const handleRefreshTeams = useCallback(async () => {
    return await refreshTeams()
  }, [refreshTeams])

  // Handle device selection
  const handleDeviceSelect = (deviceId: string) => {
    if (isExistingTask) return
    setSelectedDeviceId(deviceId)
    // Clear any existing task when selecting a new device
    selectTask(null)
    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.set('deviceId', deviceId)
    nextParams.delete('device_id')
    router.replace(`/devices/chat?${nextParams.toString()}`)
  }

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskMatchesRoute ? selectedTaskDetail?.title : undefined

  const activeDeviceId = resolveDeviceSelectionId(
    devices,
    isExistingTask ? persistedTaskDeviceId : selectedDeviceId
  )
  const selectedDevice = devices.find(d => d.device_id === activeDeviceId)

  // Check if selected device is OpenClaw type
  const isOpenClaw = selectedDevice ? isOpenClawDevice(selectedDevice) : false

  return (
    <div className="flex smart-h-screen bg-base text-text-primary box-border">
      {/* URL parameter sync */}
      <TaskParamSync />
      <DeviceParamSync />

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
              data-testid="device-chat-target-select"
              value={activeDeviceId || ''}
              onChange={e => handleDeviceSelect(e.target.value)}
              disabled={isProjectContext || isExistingTask}
              className="bg-surface border border-border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <option value="" disabled>
                {t('select_device')}
              </option>
              {conversationDevices.map(device => (
                <option
                  key={device.device_id}
                  value={device.device_id}
                  data-testid={`device-chat-option-${device.device_id}`}
                >
                  {device.device_type === 'app' ? t('wework_device_prefix') : ''}
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
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
        </TopNavigation>

        {/* Chat area or placeholder */}
        {/* Show ChatArea when device is selected OR when viewing an existing task */}
        {activeDeviceId || isExistingTask ? (
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
            hideSelectors={isOpenClaw}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center bg-base">
            <div className="text-center max-w-md px-6">
              {conversationDevices.length === 0 ? (
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
