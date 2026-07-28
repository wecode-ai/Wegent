import { File, FileDiff, Globe2, Loader2, SquareTerminal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cloudDesktopExtension } from '@extensions/cloud-desktop'
import { getRuntimeConfig } from '@/config/runtime'
import type { CloudDesktopLaunchAction } from '@/extensions/cloud-desktop-contract'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  supportsCloudSessions,
  supportsLocalTerminalLaunch,
  supportsRemoteTerminalSessions,
} from '@/lib/device-capabilities'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { cn } from '@/lib/utils'
import { findWorkbenchDevice } from '@/lib/workbench-device'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import type { WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { WorkspaceTerminalWindow } from './WorkspaceTerminalWindow'
import {
  buildLocalTerminalEnv,
  getProjectDeviceId,
  getProjectLocalPath,
  getTerminalSessionLabel,
  usesLocalProjectConfig,
  type WorkspacePanelMenuActions,
  type WorkspaceTerminalSession,
  type WorkspaceTool,
} from './workspace-panel-tools'

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

type WorkspaceToolAvailability = Record<WorkspaceTool, boolean>

interface WorkspaceToolAvailabilityState {
  projectKey: string
  tools: WorkspaceToolAvailability
}

interface WorkspaceToolErrorState {
  projectKey: string
  message: string | null
}

interface WorkspaceToolLoadingState {
  tool: WorkspaceTool | 'extension'
  projectKey: string
}

interface LocalTerminalCheckState {
  key: string
  executorDeviceId: string | null
  pathExists: boolean
}

function createAvailableTools(): WorkspaceToolAvailability {
  return {
    terminal: true,
  }
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
  const { t } = useTranslation('common')
  const testId = useCallback(
    (value: string) => (testIdsEnabled ? value : undefined),
    [testIdsEnabled]
  )
  const [terminalSessions, setTerminalSessions] = useState<WorkspaceTerminalSession[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [loadingToolState, setLoadingToolState] = useState<WorkspaceToolLoadingState | null>(null)
  const defaultOpenedProjectKeyRef = useRef<string | null>(null)
  const terminalSessionsRef = useRef<WorkspaceTerminalSession[]>([])
  const terminalProjectKeyRef = useRef<string | null>(null)
  const [toolAvailability, setToolAvailability] = useState<WorkspaceToolAvailabilityState>(() => ({
    projectKey: '',
    tools: createAvailableTools(),
  }))
  const [toolError, setToolError] = useState<WorkspaceToolErrorState>({
    projectKey: '',
    message: null,
  })
  const projectDeviceId = getProjectDeviceId(currentProject)
  const workspaceSource = workspaceTarget?.source
  const activeWorkspaceDeviceId = workspaceTarget?.deviceId ?? projectDeviceId
  const activeWorkspacePath =
    workspaceTarget?.path ?? (currentProject ? getProjectLocalPath(currentProject) : undefined)
  const projectDevice = activeWorkspaceDeviceId
    ? (findWorkbenchDevice(devices, activeWorkspaceDeviceId) ?? undefined)
    : undefined
  const cloudToolsAvailable = Boolean(
    projectDevice && supportsCloudSessions(projectDevice, activeWorkspaceDeviceId)
  )
  const remoteTerminalAvailable = Boolean(
    projectDevice && supportsRemoteTerminalSessions(projectDevice, activeWorkspaceDeviceId)
  )
  const remoteWorkspaceSession = Boolean(
    workspaceTarget?.workspaceSource === 'remote' || cloudToolsAvailable || remoteTerminalAvailable
  )
  const localProjectConfigTerminal =
    workspaceSource !== 'runtime' && (preferLocalTerminal || usesLocalProjectConfig(currentProject))
  const localTerminalSupported = Boolean(
    !remoteWorkspaceSession &&
    (localProjectConfigTerminal || (projectDevice && supportsLocalTerminalLaunch(projectDevice)))
  )
  const localTerminalRuntimeAvailable = isLocalTerminalAvailable()
  const localTerminalCheckKey = [
    localTerminalRuntimeAvailable ? 'tauri-macos' : 'unavailable',
    projectDevice?.device_id ?? '',
    projectDevice?.device_type ?? '',
    projectDevice?.bind_shell ?? '',
    activeWorkspacePath ?? '',
  ].join(':')
  const [localTerminalCheck, setLocalTerminalCheck] = useState<LocalTerminalCheckState>({
    key: '',
    executorDeviceId: null,
    pathExists: false,
  })
  const localTerminalCheckReady = localTerminalCheck.key === localTerminalCheckKey
  const hasWorkspaceContext = Boolean(currentProject || workspaceTarget)
  const canUseLocalTerminalCheck = useCallback(
    (check: LocalTerminalCheckState) => {
      const configuredDeviceMatches = Boolean(
        activeWorkspaceDeviceId && check.executorDeviceId === activeWorkspaceDeviceId
      )
      const hasWorkspacePath = Boolean(activeWorkspacePath?.trim())

      return Boolean(
        localTerminalSupported &&
        localTerminalRuntimeAvailable &&
        check.key === localTerminalCheckKey &&
        (configuredDeviceMatches || check.pathExists || !hasWorkspacePath)
      )
    },
    [
      activeWorkspaceDeviceId,
      activeWorkspacePath,
      localTerminalCheckKey,
      localTerminalRuntimeAvailable,
      localTerminalSupported,
    ]
  )
  const localTerminalAvailable = canUseLocalTerminalCheck(localTerminalCheck)
  const localTerminalCheckPending = Boolean(
    localTerminalSupported && localTerminalRuntimeAvailable && !localTerminalCheckReady
  )
  const localTerminalLaunchable = Boolean(localTerminalSupported && localTerminalRuntimeAvailable)
  const useDeviceTerminalSession = Boolean(remoteWorkspaceSession && workspaceTarget)
  const projectTerminalAvailable =
    localTerminalLaunchable ||
    (!localTerminalSupported &&
      (Boolean(currentProject) || Boolean(workspaceSource === 'runtime' && activeWorkspacePath)) &&
      remoteTerminalAvailable)
  const hasLimitedProjectTools = Boolean(
    hasWorkspaceContext &&
    !cloudToolsAvailable &&
    !localTerminalCheckPending &&
    !projectTerminalAvailable
  )
  const projectKey = hasWorkspaceContext
    ? [
        currentProject?.id ?? 'workspace',
        activeWorkspaceDeviceId ?? '',
        activeWorkspacePath ?? '',
        preferLocalTerminal ? 'local' : 'configured',
      ].join(':')
    : ''
  const cloudDesktopAvailable = Boolean(
    cloudToolsAvailable && cloudDesktopExtension.available && activeWorkspaceDeviceId
  )
  const cloudDesktopLaunchActionRef = useRef<CloudDesktopLaunchAction | null>(null)
  const availableTools =
    toolAvailability.projectKey === projectKey ? toolAvailability.tools : createAvailableTools()
  const error = toolError.projectKey === projectKey ? toolError.message : null
  const loadingTool = loadingToolState?.projectKey === projectKey ? loadingToolState.tool : null
  const toolsDisabled = !hasWorkspaceContext || Boolean(loadingTool)
  const activeTerminalSession =
    terminalSessions.find(session => session.session_id === activeTerminalSessionId) ??
    terminalSessions[0] ??
    null
  const activeTerminalTitle = getTerminalSessionLabel(activeTerminalSession)

  useEffect(() => {
    terminalSessionsRef.current = terminalSessions
  }, [terminalSessions])

  useEffect(() => {
    if (activeTerminalTitle) {
      onTerminalTitleChange?.(activeTerminalTitle)
    }
  }, [activeTerminalTitle, onTerminalTitleChange])

  useEffect(() => {
    return () => {
      terminalSessionsRef.current.forEach(session => {
        if (session.terminal_kind === 'local') {
          void closeLocalTerminal(session.session_id)
        }
      })
    }
  }, [])

  useEffect(() => {
    if (terminalProjectKeyRef.current === null) {
      terminalProjectKeyRef.current = projectKey
      return
    }
    if (terminalProjectKeyRef.current === projectKey) {
      return
    }

    terminalSessionsRef.current.forEach(session => {
      if (session.terminal_kind === 'local') {
        void closeLocalTerminal(session.session_id)
      }
    })
    terminalSessionsRef.current = []
    setTerminalSessions([])
    setActiveTerminalSessionId(null)
    defaultOpenedProjectKeyRef.current = null
    terminalProjectKeyRef.current = projectKey
  }, [projectKey])

  const readLocalTerminalCheck = useCallback(async (): Promise<LocalTerminalCheckState> => {
    const { apiBaseUrl } = getRuntimeConfig()

    try {
      const [deviceId, pathExists] = await Promise.all([
        getLocalExecutorDeviceId(apiBaseUrl),
        localPathExists(activeWorkspacePath),
      ])
      return {
        key: localTerminalCheckKey,
        executorDeviceId: deviceId,
        pathExists,
      }
    } catch {
      return {
        key: localTerminalCheckKey,
        executorDeviceId: null,
        pathExists: false,
      }
    }
  }, [activeWorkspacePath, localTerminalCheckKey])

  useEffect(() => {
    if (!localTerminalSupported || !localTerminalRuntimeAvailable) {
      return
    }

    let cancelled = false
    readLocalTerminalCheck()
      .then(check => {
        if (!cancelled) {
          setLocalTerminalCheck(check)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalTerminalCheck({
            key: localTerminalCheckKey,
            executorDeviceId: null,
            pathExists: false,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    localTerminalCheckKey,
    localTerminalRuntimeAvailable,
    localTerminalSupported,
    readLocalTerminalCheck,
  ])

  const markToolUnavailable = useCallback(
    (tool: WorkspaceTool) => {
      setToolAvailability(state => {
        const tools = state.projectKey === projectKey ? state.tools : createAvailableTools()
        if (!tools[tool]) {
          return state.projectKey === projectKey ? state : { projectKey, tools }
        }
        return {
          projectKey,
          tools: { ...tools, [tool]: false },
        }
      })
    },
    [projectKey]
  )

  const setProjectError = useCallback(
    (message: string | null) => {
      setToolError({ projectKey, message })
    },
    [projectKey]
  )

  const getSessionStartErrorMessage = useCallback(
    () => t('workbench.project_tool_start_failed', '启动失败'),
    [t]
  )

  const startTerminalSession = useCallback(async () => {
    if (!hasWorkspaceContext || loadingTool || !availableTools.terminal) return
    setLoadingToolState({ tool: 'terminal', projectKey })
    setProjectError(null)
    try {
      let shouldUseLocalTerminal = localTerminalAvailable
      let resolvedLocalTerminalCheck = localTerminalCheck
      if (!shouldUseLocalTerminal && localTerminalCheckPending) {
        const check = await readLocalTerminalCheck()
        setLocalTerminalCheck(check)
        resolvedLocalTerminalCheck = check
        shouldUseLocalTerminal = canUseLocalTerminalCheck(check)
      }

      if (shouldUseLocalTerminal) {
        const sessionId = await startLocalTerminal({
          cwd: activeWorkspacePath,
          env: buildLocalTerminalEnv({
            title: terminalContextTitle,
            projectName: currentProject?.name,
            workspacePath: activeWorkspacePath,
          }),
        })
        const sessionDeviceId =
          activeWorkspaceDeviceId ?? resolvedLocalTerminalCheck.executorDeviceId ?? 'local'
        setTerminalSessions(sessions => [
          ...sessions,
          {
            terminal_kind: 'local',
            session_id: sessionId,
            project_id: currentProject?.id ?? 0,
            device_id: sessionDeviceId,
            type: 'terminal',
            path: activeWorkspacePath ?? '',
            url: '',
            transport: 'socketio',
            cwd: activeWorkspacePath,
          },
        ])
        setActiveTerminalSessionId(sessionId)
        return
      }

      if (localTerminalSupported) {
        markToolUnavailable('terminal')
        setProjectError(getSessionStartErrorMessage())
        return
      }

      if (useDeviceTerminalSession) {
        if (!activeWorkspaceDeviceId || !activeWorkspacePath) {
          throw new Error('Remote workspace target is missing')
        }
        if (!workspaceSessionApi) {
          throw new Error('Remote workspace session service is unavailable')
        }
        const session = await workspaceSessionApi.startDeviceTerminal(
          activeWorkspaceDeviceId,
          activeWorkspacePath
        )
        const startedSession = {
          ...session,
          project_id: currentProject?.id ?? 0,
        }
        if (startedSession.transport !== 'socketio') {
          throw new Error('Terminal session transport is not supported')
        }
        setTerminalSessions(sessions => [
          ...sessions,
          {
            ...startedSession,
            terminal_kind: 'remote',
            remoteClientFactory: workspaceSessionApi.createRemoteTerminalClient,
          },
        ])
        setActiveTerminalSessionId(startedSession.session_id)
        return
      }

      if (!currentProject) {
        return
      }

      if (!workspaceSessionApi) {
        throw new Error('Remote workspace session service is unavailable')
      }
      const startedSession = await workspaceSessionApi.startProjectTerminal(currentProject.id)
      if (startedSession.transport !== 'socketio') {
        throw new Error('Terminal session transport is not supported')
      }
      setTerminalSessions(sessions => [
        ...sessions,
        {
          ...startedSession,
          terminal_kind: 'remote',
          remoteClientFactory: workspaceSessionApi.createRemoteTerminalClient,
        },
      ])
      setActiveTerminalSessionId(startedSession.session_id)
    } catch (e) {
      console.error('Failed to start project terminal:', e)
      markToolUnavailable('terminal')
      setProjectError(getSessionStartErrorMessage())
    } finally {
      setLoadingToolState(current =>
        current?.tool === 'terminal' && current.projectKey === projectKey ? null : current
      )
    }
  }, [
    activeWorkspaceDeviceId,
    activeWorkspacePath,
    availableTools.terminal,
    currentProject,
    getSessionStartErrorMessage,
    hasWorkspaceContext,
    loadingTool,
    canUseLocalTerminalCheck,
    localTerminalCheck,
    localTerminalCheckPending,
    localTerminalSupported,
    localTerminalAvailable,
    markToolUnavailable,
    projectKey,
    readLocalTerminalCheck,
    setLocalTerminalCheck,
    setProjectError,
    terminalContextTitle,
    useDeviceTerminalSession,
    workspaceSessionApi,
  ])

  useEffect(() => {
    if (
      defaultOpenTool !== 'terminal' ||
      !panelActive ||
      defaultOpenedProjectKeyRef.current === projectKey ||
      terminalSessions.length > 0 ||
      !hasWorkspaceContext ||
      loadingTool ||
      localTerminalCheckPending ||
      !projectTerminalAvailable ||
      !availableTools.terminal
    ) {
      return
    }

    defaultOpenedProjectKeyRef.current = projectKey
    void startTerminalSession()
  }, [
    availableTools.terminal,
    defaultOpenTool,
    hasWorkspaceContext,
    panelActive,
    localTerminalCheckPending,
    loadingTool,
    projectKey,
    projectTerminalAvailable,
    startTerminalSession,
    terminalSessions.length,
  ])

  const handleTerminalClick = useCallback(() => {
    void startTerminalSession()
  }, [startTerminalSession])

  const handleCloseTerminalSession = (sessionId: string) => {
    const session = terminalSessions.find(session => session.session_id === sessionId)
    if (session?.terminal_kind === 'local') {
      void closeLocalTerminal(sessionId)
    }

    removeTerminalSession(sessionId)
  }

  const handleTerminalSessionExit = (sessionId: string) => {
    removeTerminalSession(sessionId)
  }

  const handleTerminalTitleChange = (sessionId: string, title: string) => {
    const normalizedTitle = title.trim()
    if (!normalizedTitle) return

    setTerminalSessions(sessions =>
      sessions.map(session =>
        session.session_id === sessionId && session.title !== normalizedTitle
          ? { ...session, title: normalizedTitle }
          : session
      )
    )
  }

  const removeTerminalSession = (sessionId: string) => {
    setTerminalSessions(sessions => {
      const closeIndex = sessions.findIndex(session => session.session_id === sessionId)
      const remaining = sessions.filter(session => session.session_id !== sessionId)
      const shouldSelectNext =
        sessionId === activeTerminalSessionId ||
        !remaining.some(session => session.session_id === activeTerminalSessionId)

      if (shouldSelectNext) {
        const nextSession = remaining[Math.max(closeIndex - 1, 0)] ?? remaining[0] ?? null
        setActiveTerminalSessionId(nextSession?.session_id ?? null)
      }

      return remaining
    })

    if (hideTerminalChrome && terminalSessions.length <= 1) {
      onRequestClose?.()
    }
  }

  const handleDesktopBusyChange = useCallback(
    (busy: boolean) => {
      setLoadingToolState(current => {
        if (busy) return { tool: 'extension', projectKey }
        return current?.tool === 'extension' && current.projectKey === projectKey ? null : current
      })
    },
    [projectKey]
  )

  const handleDesktopOpened = useCallback(() => {
    onRequestClose?.()
  }, [onRequestClose])

  const handleDesktopLaunchActionChange = useCallback((action: CloudDesktopLaunchAction | null) => {
    cloudDesktopLaunchActionRef.current = action
  }, [])

  const menuActions = useMemo<WorkspacePanelMenuActions>(
    () => ({
      terminal: {
        visible: projectTerminalAvailable,
        disabled: toolsDisabled || !availableTools.terminal,
        run: startTerminalSession,
      },
      desktop: {
        visible: cloudDesktopAvailable,
        disabled: toolsDisabled || projectDevice?.status !== 'online',
        run: async () => {
          await cloudDesktopLaunchActionRef.current?.({ notifyOpened: false })
        },
      },
    }),
    [
      availableTools.terminal,
      cloudDesktopAvailable,
      projectDevice?.status,
      projectTerminalAvailable,
      startTerminalSession,
      toolsDisabled,
    ]
  )

  useEffect(() => {
    onMenuActionsChange?.(menuActions)
  }, [menuActions, onMenuActionsChange])

  useEffect(() => {
    return () => onMenuActionsChange?.(null)
  }, [onMenuActionsChange])

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
          onSelectTerminalSession={setActiveTerminalSessionId}
          onCloseTerminalSession={handleCloseTerminalSession}
          onTerminalSessionExit={handleTerminalSessionExit}
          onTerminalTitleChange={handleTerminalTitleChange}
        />
      )}
      {activeTerminalSession && error && (
        <p
          data-testid={testId('workspace-tool-error')}
          role="alert"
          className="pointer-events-none absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-md bg-red-50 px-3 py-1.5 text-sm leading-[18px] text-red-600 shadow-sm dark:bg-red-950/80 dark:text-red-300"
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
            <p className="text-center text-sm leading-[18px] text-red-500" role="alert">
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
          {(projectTerminalAvailable || cloudDesktopAvailable) && (
            <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4">
              {projectTerminalAvailable && (
                <button
                  type="button"
                  data-testid={
                    activeTerminalSession ? undefined : testId('workspace-terminal-card')
                  }
                  onClick={handleTerminalClick}
                  disabled={toolsDisabled || !availableTools.terminal}
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
                    {availableTools.terminal
                      ? t('workbench.start_shell', '启动交互式 shell')
                      : t('workbench.project_tool_unavailable', '暂不可用')}
                  </span>
                </button>
              )}
              {cloudDesktopAvailable && activeWorkspaceDeviceId && (
                <cloudDesktopExtension.WorkspaceAction
                  contextKey={projectKey}
                  deviceId={activeWorkspaceDeviceId}
                  disabled={toolsDisabled || projectDevice?.status !== 'online'}
                  onBusyChange={handleDesktopBusyChange}
                  onErrorChange={setProjectError}
                  onLaunchActionChange={handleDesktopLaunchActionChange}
                  onOpened={handleDesktopOpened}
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
