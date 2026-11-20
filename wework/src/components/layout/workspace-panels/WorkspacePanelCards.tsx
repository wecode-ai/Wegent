import type { DeviceSurfaceLaunchAction } from '@/extensions/device-surface-contract'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  supportsCloudSessions,
  supportsLocalTerminalLaunch,
  supportsRemoteSessions,
  supportsRemoteTerminalSessions,
} from '@/lib/device-capabilities'
import { isLocalTerminalAvailable } from '@/lib/local-terminal'
import { cn } from '@/lib/utils'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { deviceSurfaceExtension } from '@extensions/device-surface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { File, FileDiff, Globe2, Loader2, SquareTerminal } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspaceTerminalWindow } from './WorkspaceTerminalWindow'
import {
  getProjectDeviceId,
  getProjectLocalPath,
  usesLocalProjectConfig,
  type WorkspacePanelMenuActions,
  type WorkspaceTool,
} from './workspace-panel-tools'
import {
  createWorkspacePanelCardsState,
  type WorkspacePanelCardsContext,
} from './workspacePanelCardsState'

interface WorkspacePanelCardsProps {
  showWorkbenchBackground?: boolean
  currentProject: ProjectWithTasks | null
  devices?: DeviceInfo[]
  workspaceTarget?: WorkspaceTarget | null
  defaultOpenTool?: WorkspaceTool
  onRequestClose?: () => void
  canOpenReview?: boolean
  onSelectReview?: () => void
  onSelectBrowser?: () => void
  onSelectFiles?: () => void
  hideTerminalChrome?: boolean
  preferLocalTerminal?: boolean
  panelActive?: boolean
  testIdsEnabled?: boolean
  terminalContextTitle?: string | null
  onTerminalTitleChange?: (title: string) => void
  onMenuActionsChange?: (actions: WorkspacePanelMenuActions | null) => void
  workspaceSessionApi?: WorkspaceSessionApi
}

export function WorkspacePanelCards({
  showWorkbenchBackground = false,
  currentProject,
  devices = [],
  workspaceTarget = null,
  defaultOpenTool,
  onRequestClose,
  canOpenReview = false,
  onSelectReview,
  onSelectBrowser,
  onSelectFiles,
  hideTerminalChrome = false,
  preferLocalTerminal = false,
  panelActive = true,
  testIdsEnabled = true,
  terminalContextTitle,
  onTerminalTitleChange,
  onMenuActionsChange,
  workspaceSessionApi,
}: WorkspacePanelCardsProps) {
  const { t, i18n } = useTranslation('common')
  const testId = useCallback(
    (value: string) => (testIdsEnabled ? value : undefined),
    [testIdsEnabled]
  )
  const [source] = useState(createWorkspacePanelCardsState)
  const projectDeviceId = getProjectDeviceId(currentProject)
  const workspaceSource = workspaceTarget?.source
  const activeWorkspaceTaskId = workspaceTarget?.taskId
  const activeWorkspaceDeviceId = workspaceTarget?.deviceId ?? projectDeviceId
  const activeWorkspacePath =
    workspaceTarget?.path ?? (currentProject ? getProjectLocalPath(currentProject) : undefined)
  const projectDevice = activeWorkspaceDeviceId
    ? (findWorkbenchDevice(devices, activeWorkspaceDeviceId) ?? undefined)
    : undefined
  const cloudToolsAvailable = Boolean(
    projectDevice && supportsCloudSessions(projectDevice, activeWorkspaceDeviceId)
  )
  const deviceSurfaceAvailable = Boolean(
    deviceSurfaceExtension.available &&
    projectDevice &&
    deviceSurfaceExtension.supportsDevice(projectDevice, activeWorkspaceDeviceId)
  )
  const language = i18n.resolvedLanguage ?? i18n.language
  const deviceSurfaceMenuItem = useMemo(
    () => deviceSurfaceExtension.workspaceMenuItem(language),
    [language]
  )
  const remoteSessionTarget = Boolean(
    projectDevice &&
    (supportsCloudSessions(projectDevice, activeWorkspaceDeviceId) ||
      supportsRemoteSessions(projectDevice, activeWorkspaceDeviceId))
  )
  const remoteTerminalAvailable = Boolean(
    remoteSessionTarget &&
    projectDevice &&
    supportsRemoteTerminalSessions(projectDevice, activeWorkspaceDeviceId)
  )
  const remoteWorkspaceSession = Boolean(
    workspaceTarget?.workspaceSource === 'remote' || remoteSessionTarget
  )
  const localProjectConfigTerminal =
    workspaceSource !== 'runtime' && (preferLocalTerminal || usesLocalProjectConfig(currentProject))
  const localTerminalSupported = Boolean(
    !remoteWorkspaceSession &&
    (localProjectConfigTerminal || (projectDevice && supportsLocalTerminalLaunch(projectDevice)))
  )
  const localTerminalRuntimeAvailable = isLocalTerminalAvailable()
  const localTerminalCheckKey = [
    localTerminalRuntimeAvailable ? 'electron' : 'unavailable',
    projectDevice?.device_id ?? '',
    projectDevice?.device_type ?? '',
    projectDevice?.bind_shell ?? '',
    activeWorkspacePath ?? '',
  ].join(':')
  const hasWorkspaceContext = Boolean(currentProject || workspaceTarget)
  const localTerminalLaunchable = Boolean(localTerminalSupported && localTerminalRuntimeAvailable)
  const useDeviceTerminalSession = Boolean(remoteWorkspaceSession && workspaceTarget)
  const projectTerminalAvailable =
    localTerminalLaunchable ||
    (!localTerminalSupported &&
      (Boolean(currentProject) || Boolean(workspaceSource === 'runtime' && activeWorkspacePath)) &&
      remoteTerminalAvailable)
  const showTerminalEntry = Boolean(
    projectTerminalAvailable || (hasWorkspaceContext && remoteSessionTarget)
  )
  const projectKey = hasWorkspaceContext
    ? [
        currentProject?.id ?? 'workspace',
        activeWorkspaceDeviceId ?? '',
        activeWorkspacePath ?? '',
        preferLocalTerminal ? 'local' : 'configured',
      ].join(':')
    : ''
  const context = useMemo<WorkspacePanelCardsContext>(
    () => ({
      projectKey,
      currentProject,
      activeWorkspaceDeviceId,
      activeWorkspacePath,
      activeWorkspaceTaskId,
      hasWorkspaceContext,
      localTerminalSupported,
      localTerminalRuntimeAvailable,
      localTerminalCheckKey,
      projectTerminalAvailable,
      useDeviceTerminalSession,
      defaultOpenTool,
      panelActive,
      hideTerminalChrome,
      terminalContextTitle,
      workspaceSessionApi,
      showTerminalEntry,
      deviceSurfaceAvailable,
      deviceSurfaceMenuItem,
      deviceOnline: projectDevice?.status === 'online',
      unavailableMessage: t('workbench.project_terminal_unavailable_tooltip'),
      startErrorMessage: t('workbench.project_tool_start_failed', '启动失败'),
      onTerminalTitleChange,
      onMenuActionsChange,
      onRequestClose,
    }),
    [
      projectKey,
      currentProject,
      activeWorkspaceDeviceId,
      activeWorkspacePath,
      activeWorkspaceTaskId,
      hasWorkspaceContext,
      localTerminalSupported,
      localTerminalRuntimeAvailable,
      localTerminalCheckKey,
      projectTerminalAvailable,
      useDeviceTerminalSession,
      defaultOpenTool,
      panelActive,
      hideTerminalChrome,
      terminalContextTitle,
      workspaceSessionApi,
      showTerminalEntry,
      deviceSurfaceAvailable,
      deviceSurfaceMenuItem,
      projectDevice?.status,
      t,
      onTerminalTitleChange,
      onMenuActionsChange,
      onRequestClose,
    ]
  )
  const sessionState = useSyncExternalStore(source.subscribeSessions, source.getSessionsSnapshot)
  const subscribeTools = useCallback(
    (notify: () => void) => source.subscribeTools(notify, context),
    [source, context]
  )
  const toolState = useSyncExternalStore(subscribeTools, source.getToolsSnapshot)
  const terminalSessions =
    sessionState.projectKey === projectKey ? sessionState.terminalSessions : []
  const activeTerminalSessionId =
    sessionState.projectKey === projectKey ? sessionState.activeTerminalSessionId : null
  const availableTools =
    toolState.projectKey === projectKey ? toolState.availableTools : { terminal: true }
  const error = toolState.projectKey === projectKey ? toolState.error : null
  const loadingTool = toolState.projectKey === projectKey ? toolState.loadingTool : null
  const localTerminalCheckPending = Boolean(
    localTerminalSupported &&
    localTerminalRuntimeAvailable &&
    toolState.localTerminalCheck.key !== localTerminalCheckKey
  )
  const toolsDisabled = !hasWorkspaceContext || Boolean(loadingTool)
  const hasLimitedProjectTools = Boolean(
    hasWorkspaceContext && !cloudToolsAvailable && !localTerminalCheckPending && !showTerminalEntry
  )
  const activeTerminalSession =
    terminalSessions.find(session => session.session_id === activeTerminalSessionId) ??
    terminalSessions[0] ??
    null
  const handleTerminalClick = useCallback(() => {
    void source.startTerminal(projectKey)
  }, [source, projectKey])
  const handleCloseTerminalSession = (id: string) => source.closeSession(projectKey, id)
  const handleTerminalSessionExit = (id: string) => source.exited(projectKey, id)
  const handleTerminalTitleChange = (id: string, title: string) =>
    source.titleChanged(projectKey, id, title)
  const handleExtensionBusyChange = useCallback(
    (busy: boolean) => source.extensionBusy(projectKey, busy),
    [source, projectKey]
  )
  const setProjectError = useCallback(
    (error: string | null) => source.extensionError(projectKey, error),
    [source, projectKey]
  )
  const handleExtensionOpened = useCallback(
    () => source.extensionOpened(projectKey),
    [source, projectKey]
  )
  const handleExtensionLaunchActionChange = useCallback(
    (action: DeviceSurfaceLaunchAction | null) => source.setExtensionAction(projectKey, action),
    [source, projectKey]
  )
  const terminalAddMenuItems = useMemo(() => {
    const items: WorkspaceAddMenuItem[] = []

    if (onSelectReview) {
      items.push({
        id: 'review',
        testId: testId('workspace-add-review-option'),
        icon: FileDiff,
        label: t('workbench.workspace_tab_review', '审查'),
        disabled: !canOpenReview,
        onSelect: onSelectReview,
      })
    }

    items.push({
      id: 'terminal',
      testId: testId('workspace-add-terminal-option'),
      icon: SquareTerminal,
      label: t('workbench.terminal', '终端'),
      disabled: toolsDisabled || !projectTerminalAvailable || !availableTools.terminal,
      title: !projectTerminalAvailable
        ? t('workbench.project_terminal_unavailable_tooltip')
        : undefined,
      onSelect: handleTerminalClick,
    })

    if (onSelectBrowser) {
      items.push({
        id: 'browser',
        testId: testId('workspace-add-browser-option'),
        icon: Globe2,
        label: t('workbench.browser'),
        onSelect: onSelectBrowser,
      })
    }

    if (onSelectFiles) {
      items.push({
        id: 'files',
        testId: testId('workspace-add-files-option'),
        icon: File,
        label: t('workbench.workspace_tab_files', '文件'),
        onSelect: onSelectFiles,
      })
    }

    return items
  }, [
    availableTools.terminal,
    canOpenReview,
    handleTerminalClick,
    onSelectBrowser,
    onSelectFiles,
    onSelectReview,
    projectTerminalAvailable,
    t,
    testId,
    toolsDisabled,
  ])

  return (
    <div className="relative h-full min-h-0 w-full">
      {activeTerminalSession && (
        <WorkspaceTerminalWindow
          showWorkbenchBackground={showWorkbenchBackground}
          hideTerminalChrome={hideTerminalChrome}
          panelActive={panelActive}
          testIdsEnabled={testIdsEnabled}
          terminalSessions={terminalSessions}
          activeTerminalSession={activeTerminalSession}
          workspaceTarget={workspaceTarget}
          activeWorkspacePath={activeWorkspacePath}
          terminalAddMenuItems={terminalAddMenuItems}
          onSelectTerminalSession={id => source.selectSession(projectKey, id)}
          onCloseTerminalSession={handleCloseTerminalSession}
          onTerminalSessionExit={handleTerminalSessionExit}
          onTerminalTitleChange={handleTerminalTitleChange}
        />
      )}
      {activeTerminalSession && error && (
        <p
          data-testid={testId('workspace-tool-error')}
          role="alert"
          className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-md bg-destructive/10 px-3 py-1.5 text-sm leading-[18px] text-destructive shadow-sm wework:bg-red-50 wework:text-red-600 wework:dark:bg-red-950/80 wework:dark:text-red-300"
        >
          {error}
        </p>
      )}
      <div
        data-testid={activeTerminalSession ? undefined : testId('workspace-tool-launcher')}
        className={cn('h-full min-h-0 w-full flex-col', activeTerminalSession ? 'hidden' : 'flex')}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-8 py-6">
          {!hasWorkspaceContext && (
            <p className="text-center text-sm leading-[18px] text-text-secondary">
              {t('workbench.project_tool_requires_project', '请选择项目后使用')}
            </p>
          )}
          {error && (
            <p
              className="text-center text-sm leading-[18px] text-destructive wework:text-red-500"
              role="alert"
            >
              {error}
            </p>
          )}
          {hasLimitedProjectTools && (
            <div
              data-testid={testId('workspace-local-device-limited-tools')}
              className="rounded-lg border border-border bg-surface px-4 py-5 text-center"
            >
              <p className="text-sm font-semibold text-text-primary">
                {t('workbench.local_device_limited_tools_title')}
              </p>
              <p className="mt-2 text-sm leading-[18px] text-text-secondary">
                {t('workbench.local_device_limited_tools_desc')}
              </p>
            </div>
          )}
          {(showTerminalEntry || deviceSurfaceAvailable) && (
            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4">
              {showTerminalEntry && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={
                    activeTerminalSession ? undefined : testId('workspace-terminal-card')
                  }
                  onClick={handleTerminalClick}
                  disabled={toolsDisabled || !projectTerminalAvailable || !availableTools.terminal}
                  title={
                    !projectTerminalAvailable
                      ? t('workbench.project_terminal_unavailable_tooltip')
                      : undefined
                  }
                  className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingTool === 'terminal' ? (
                    <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
                  ) : (
                    <SquareTerminal className="mb-5 h-7 w-7 text-text-secondary" />
                  )}
                  <span className="text-sm font-semibold text-text-primary">
                    {t('workbench.terminal', '终端')}
                  </span>
                  <span className="mt-2 text-sm leading-[18px] text-text-secondary">
                    {!projectTerminalAvailable
                      ? t('workbench.project_terminal_disabled_by_device')
                      : availableTools.terminal
                        ? t('workbench.start_shell', '启动交互式 shell')
                        : t('workbench.project_tool_unavailable', '暂不可用')}
                  </span>
                </ControlButton>
              )}
              {deviceSurfaceAvailable && activeWorkspaceDeviceId && (
                <deviceSurfaceExtension.WorkspaceAction
                  contextKey={projectKey}
                  deviceId={activeWorkspaceDeviceId}
                  disabled={toolsDisabled || projectDevice?.status !== 'online'}
                  onBusyChange={handleExtensionBusyChange}
                  onErrorChange={setProjectError}
                  onLaunchActionChange={handleExtensionLaunchActionChange}
                  onOpened={handleExtensionOpened}
                  testIdsEnabled={testIdsEnabled && !activeTerminalSession}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
