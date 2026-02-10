// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
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
import { Monitor, WifiOff, FolderOpen } from 'lucide-react'
import { ChatArea } from '@/features/tasks/components/chat'
import { TaskParamSync, DeviceTaskSync } from '@/features/tasks/components/params'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type WorkdirPolicy = 'managed' | 'existing'
type WorkdirDisplayPolicy = 'managed' | 'existing' | 'repo_bound'

interface WorkdirSelection {
  workdir?: string
  workdir_policy: WorkdirPolicy
}

function shortenPath(path: string, maxLength = 32): string {
  if (path.length <= maxLength) {
    return path
  }
  return `...${path.slice(-(maxLength - 3))}`
}

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

  // Mobile sidebar state
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false)

  // Collapsed sidebar state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Workdir state for new tasks
  const [draftWorkdirPolicy, setDraftWorkdirPolicy] = useState<WorkdirPolicy>('managed')
  const [draftWorkdirPath, setDraftWorkdirPath] = useState('')
  const [isWorkdirDialogOpen, setIsWorkdirDialogOpen] = useState(false)
  const [dialogWorkdirPolicy, setDialogWorkdirPolicy] = useState<WorkdirPolicy>('managed')
  const [dialogWorkdirPath, setDialogWorkdirPath] = useState('')
  const [dialogWorkdirError, setDialogWorkdirError] = useState<string | null>(null)
  const pendingWorkdirResolveRef = useRef<((value: WorkdirSelection | null) => void) | null>(null)

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
  }

  // Get current task title for top navigation
  const currentTaskTitle = selectedTaskDetail?.title

  // Get selected device info
  const selectedDevice = devices.find(d => d.device_id === selectedDeviceId)

  const resolveWorkdirForNewTask = useCallback((): Promise<WorkdirSelection | null> => {
    return new Promise(resolve => {
      pendingWorkdirResolveRef.current = resolve
      setDialogWorkdirPolicy(draftWorkdirPolicy)
      setDialogWorkdirPath(draftWorkdirPath)
      setDialogWorkdirError(null)
      setIsWorkdirDialogOpen(true)
    })
  }, [draftWorkdirPolicy, draftWorkdirPath])

  const closeWorkdirDialog = useCallback((result: WorkdirSelection | null) => {
    setIsWorkdirDialogOpen(false)
    setDialogWorkdirError(null)
    if (pendingWorkdirResolveRef.current) {
      pendingWorkdirResolveRef.current(result)
      pendingWorkdirResolveRef.current = null
    }
  }, [])

  const handleWorkdirDialogCancel = useCallback(() => {
    closeWorkdirDialog(null)
  }, [closeWorkdirDialog])

  const handleWorkdirDialogConfirm = useCallback(() => {
    if (dialogWorkdirPolicy === 'existing') {
      const normalizedPath = dialogWorkdirPath.trim()
      if (!normalizedPath) {
        setDialogWorkdirError(t('workdir.dialog.path_required'))
        return
      }

      if (!(normalizedPath.startsWith('/') || normalizedPath.startsWith('~'))) {
        setDialogWorkdirError(t('workdir.dialog.path_absolute_required'))
        return
      }

      setDraftWorkdirPolicy('existing')
      setDraftWorkdirPath(normalizedPath)
      closeWorkdirDialog({
        workdir_policy: 'existing',
        workdir: normalizedPath,
      })
      return
    }

    setDraftWorkdirPolicy('managed')
    setDraftWorkdirPath('')
    closeWorkdirDialog({
      workdir_policy: 'managed',
    })
  }, [closeWorkdirDialog, dialogWorkdirPath, dialogWorkdirPolicy, t])

  const handleWorkdirDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        handleWorkdirDialogCancel()
      }
    },
    [handleWorkdirDialogCancel]
  )

  useEffect(() => {
    return () => {
      if (pendingWorkdirResolveRef.current) {
        pendingWorkdirResolveRef.current(null)
        pendingWorkdirResolveRef.current = null
      }
    }
  }, [])

  const currentWorkdirPolicy = (selectedTaskDetail?.workdir_policy ??
    draftWorkdirPolicy) as WorkdirDisplayPolicy
  const currentWorkdirPath = selectedTaskDetail?.workdir || draftWorkdirPath

  const workdirDisplayText = useMemo(() => {
    if (currentWorkdirPolicy === 'existing') {
      return currentWorkdirPath
        ? shortenPath(currentWorkdirPath)
        : t('workdir.display_existing_unset')
    }
    if (currentWorkdirPolicy === 'repo_bound') {
      return currentWorkdirPath ? shortenPath(currentWorkdirPath) : t('workdir.policy_repo_bound')
    }
    return t('workdir.policy_managed')
  }, [currentWorkdirPath, currentWorkdirPolicy, t])

  const workdirDisplayTitle = useMemo(() => {
    if (currentWorkdirPolicy === 'existing' || currentWorkdirPolicy === 'repo_bound') {
      return currentWorkdirPath || workdirDisplayText
    }
    return workdirDisplayText
  }, [currentWorkdirPath, currentWorkdirPolicy, workdirDisplayText])

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
          <div
            className="hidden md:flex items-center gap-2 max-w-[260px] border border-border bg-surface rounded-md px-2 py-1"
            title={workdirDisplayTitle}
          >
            <FolderOpen className="w-4 h-4 text-text-muted flex-shrink-0" />
            <span className="text-xs text-text-muted">{t('workdir.label')}</span>
            <span className="text-sm text-text-primary truncate">{workdirDisplayText}</span>
          </div>
          {isMobile ? <ThemeToggle /> : <GithubStarButton />}
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
            onResolveWorkdirForNewTask={resolveWorkdirForNewTask}
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

      <Dialog open={isWorkdirDialogOpen} onOpenChange={handleWorkdirDialogOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('workdir.dialog.title')}</DialogTitle>
            <DialogDescription>{t('workdir.dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <RadioGroup
              value={dialogWorkdirPolicy}
              onValueChange={value => {
                setDialogWorkdirPolicy(value as WorkdirPolicy)
                setDialogWorkdirError(null)
              }}
              className="space-y-3"
            >
              <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                <RadioGroupItem value="managed" id="workdir-policy-managed" className="mt-1" />
                <Label htmlFor="workdir-policy-managed" className="flex-1 cursor-pointer">
                  <div className="text-sm font-medium text-text-primary">
                    {t('workdir.policy_managed')}
                  </div>
                  <div className="text-xs text-text-muted mt-1">
                    {t('workdir.policy_managed_description')}
                  </div>
                </Label>
              </div>

              <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                <RadioGroupItem value="existing" id="workdir-policy-existing" className="mt-1" />
                <Label htmlFor="workdir-policy-existing" className="flex-1 cursor-pointer">
                  <div className="text-sm font-medium text-text-primary">
                    {t('workdir.policy_existing')}
                  </div>
                  <div className="text-xs text-text-muted mt-1">
                    {t('workdir.policy_existing_description')}
                  </div>
                </Label>
              </div>
            </RadioGroup>

            {dialogWorkdirPolicy === 'existing' && (
              <div className="space-y-2">
                <Label htmlFor="workdir-path-input">{t('workdir.dialog.path_label')}</Label>
                <Input
                  id="workdir-path-input"
                  value={dialogWorkdirPath}
                  onChange={event => {
                    setDialogWorkdirPath(event.target.value)
                    setDialogWorkdirError(null)
                  }}
                  placeholder={t('workdir.dialog.path_placeholder')}
                />
                <p className="text-xs text-text-muted">{t('workdir.dialog.path_hint')}</p>
                {dialogWorkdirError && (
                  <p className="text-xs text-destructive">{dialogWorkdirError}</p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleWorkdirDialogCancel}
              className="h-11 min-w-[88px]"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleWorkdirDialogConfirm}
              className="h-11 min-w-[88px]"
            >
              {t('workdir.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
