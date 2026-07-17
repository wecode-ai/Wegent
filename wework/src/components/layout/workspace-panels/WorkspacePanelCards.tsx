import { File, FileDiff, Globe2, Loader2, Monitor, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRuntimeConfig } from '@/config/runtime'
import type { WorkspaceSessionApi } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DEFAULT_LOCAL_WORKSPACE_OPENER_ID,
  type LocalWorkspaceOpenerId,
} from '@/lib/local-workspace-openers'
import {
  supportsCloudSessions,
  supportsLocalTerminalLaunch,
  supportsRemoteTerminalSessions,
} from '@/lib/device-capabilities'
import { openExternalUrl } from '@/lib/external-links'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  openLocalWorkspace,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { configuredWorkspacePath } from '@/lib/project-workspace'
import { buildVncPageUrl } from '@/lib/vnc'
import type { RemoteTerminalClientFactory } from '@/lib/remote-terminal-socket'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectDeviceSessionResponse, ProjectWithTasks } from '@/types/api'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { EmbeddedLocalTerminal } from './EmbeddedLocalTerminal'
import { LocalWorkspaceOpenerIcon, LocalWorkspaceOpenerPicker } from './LocalWorkspaceOpenerMenu'
import { RemoteTerminal } from './RemoteTerminal'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'

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
  workspaceSessionApi?: WorkspaceSessionApi
}

type WorkspaceTool = 'terminal' | 'ide' | 'desktop'

type WorkspaceToolAvailability = Record<WorkspaceTool, boolean>

interface WorkspaceToolAvailabilityState {
  projectKey: string
  tools: WorkspaceToolAvailability
}

interface WorkspaceToolErrorState {
  projectKey: string
  message: string | null
}

interface LocalTerminalCheckState {
  key: string
  executorDeviceId: string | null
  pathExists: boolean
}

type WorkspaceTerminalSessionBase = ProjectDeviceSessionResponse & {
  cwd?: string
  title?: string
}

type WorkspaceTerminalSession =
  | (WorkspaceTerminalSessionBase & {
      terminal_kind: 'local'
    })
  | (WorkspaceTerminalSessionBase & {
      terminal_kind: 'remote'
      remoteClientFactory: RemoteTerminalClientFactory
    })

function createAvailableTools(): WorkspaceToolAvailability {
  return {
    terminal: true,
    ide: true,
    desktop: true,
  }
}

function getProjectDeviceId(project: ProjectWithTasks | null): string | undefined {
  return project?.config?.execution?.deviceId ?? project?.config?.device_id
}

function getProjectLocalPath(project: ProjectWithTasks): string | undefined {
  return configuredWorkspacePath(project)
}

function usesLocalProjectConfig(project: ProjectWithTasks | null): boolean {
  return Boolean(
    project &&
    (project.config?.execution?.targetType === 'local' ||
      project.config?.workspace?.source === 'local_path')
  )
}

function getPathBasename(path?: string | null): string {
  const normalizedPath = path?.trim().replace(/\/+$/, '')
  if (!normalizedPath || normalizedPath === '/') return ''
  return normalizedPath.split('/').filter(Boolean).pop() ?? ''
}

function getTerminalSessionLabel(session: WorkspaceTerminalSession | null): string {
  if (!session) return ''

  const title = session.title?.trim()
  if (title) return title

  return (
    getPathBasename(session.cwd) ||
    getPathBasename(session.path) ||
    session.device_id?.trim() ||
    session.session_id
  )
}

function buildLocalTerminalEnv({
  title,
  projectName,
  workspacePath,
}: {
  title?: string | null
  projectName?: string | null
  workspacePath?: string | null
}): Record<string, string> | undefined {
  const normalizedTitle = title?.trim()
  if (!normalizedTitle) return undefined

  const env: Record<string, string> = {
    WEWORK_PARENT_TITLE: normalizedTitle,
  }
  const normalizedProjectName = projectName?.trim()
  const normalizedWorkspacePath = workspacePath?.trim()

  if (normalizedProjectName) {
    env.WEWORK_PARENT_PROJECT = normalizedProjectName
  }
  if (normalizedWorkspacePath) {
    env.WEWORK_PARENT_WORKSPACE = normalizedWorkspacePath
  }

  return env
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
  workspaceSessionApi,
}: WorkspacePanelCardsProps) {
  const { t } = useTranslation('common')
  const testId = useCallback(
    (value: string) => (testIdsEnabled ? value : undefined),
    [testIdsEnabled]
  )
  const [terminalSessions, setTerminalSessions] = useState<WorkspaceTerminalSession[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [loadingTool, setLoadingTool] = useState<WorkspaceTool | null>(null)
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
    ? devices.find(device => device.device_id === activeWorkspaceDeviceId)
    : undefined
  const localProjectConfigTerminal =
    workspaceSource !== 'runtime' && (preferLocalTerminal || usesLocalProjectConfig(currentProject))
  const localTerminalSupported = Boolean(
    localProjectConfigTerminal || (projectDevice && supportsLocalTerminalLaunch(projectDevice))
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
  const cloudToolsAvailable = Boolean(projectDevice && supportsCloudSessions(projectDevice))
  const remoteTerminalAvailable = Boolean(
    projectDevice && supportsRemoteTerminalSessions(projectDevice)
  )
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
  const localIdeLaunchable = Boolean(
    localTerminalLaunchable && activeWorkspacePath?.trim() && localTerminalSupported
  )
  const projectTerminalAvailable =
    localTerminalLaunchable ||
    (!localTerminalSupported &&
      (Boolean(currentProject) || Boolean(workspaceSource === 'runtime' && activeWorkspacePath)) &&
      remoteTerminalAvailable)
  const projectIdeAvailable = cloudToolsAvailable || localIdeLaunchable
  const hasLimitedProjectTools = Boolean(
    hasWorkspaceContext &&
    !cloudToolsAvailable &&
    !localTerminalCheckPending &&
    !projectTerminalAvailable &&
    !projectIdeAvailable
  )
  const projectKey = hasWorkspaceContext
    ? [
        currentProject?.id ?? 'workspace',
        activeWorkspaceDeviceId ?? '',
        activeWorkspacePath ?? '',
        preferLocalTerminal ? 'local' : 'configured',
      ].join(':')
    : ''
  const availableTools =
    toolAvailability.projectKey === projectKey ? toolAvailability.tools : createAvailableTools()
  const error = toolError.projectKey === projectKey ? toolError.message : null
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
    setLoadingTool('terminal')
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

      if (workspaceSource === 'runtime' && activeWorkspaceDeviceId && activeWorkspacePath) {
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
      setLoadingTool(null)
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
    readLocalTerminalCheck,
    setLocalTerminalCheck,
    setProjectError,
    terminalContextTitle,
    workspaceSessionApi,
    workspaceSource,
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

  const handleIdeClick = async (
    opener: LocalWorkspaceOpenerId = DEFAULT_LOCAL_WORKSPACE_OPENER_ID
  ) => {
    if (loadingTool || !availableTools.ide) return
    setLoadingTool('ide')
    setProjectError(null)
    let shouldClosePanel = false
    try {
      if (localIdeLaunchable) {
        if (!activeWorkspacePath) {
          throw new Error('Local workspace path is missing')
        }
        await openLocalWorkspace({
          opener,
          path: activeWorkspacePath,
        })
        shouldClosePanel = true
        return
      }

      if (!currentProject) return
      if (!workspaceSessionApi) {
        throw new Error('Remote workspace session service is unavailable')
      }
      const session = await workspaceSessionApi.startProjectCodeServer(currentProject.id)
      if (!session.url) {
        throw new Error('IDE session URL is missing')
      }
      await openExternalUrl(session.url)
      shouldClosePanel = true
    } catch (e) {
      console.error('Failed to start project IDE:', e)
      markToolUnavailable('ide')
      setProjectError(getSessionStartErrorMessage())
    } finally {
      setLoadingTool(null)
      if (shouldClosePanel) {
        onRequestClose?.()
      }
    }
  }

  const handleDesktopClick = async () => {
    if (!activeWorkspaceDeviceId || loadingTool || !availableTools.desktop) return
    setLoadingTool('desktop')
    setProjectError(null)
    let shouldClosePanel = false
    try {
      if (!workspaceSessionApi) {
        throw new Error('Remote workspace session service is unavailable')
      }
      const config = await workspaceSessionApi.getDeviceVncConfig(activeWorkspaceDeviceId)
      if (!config.sandbox_id) {
        throw new Error('Desktop sandbox ID is missing')
      }
      await openExternalUrl(buildVncPageUrl(activeWorkspaceDeviceId, config.sandbox_id))
      shouldClosePanel = true
    } catch (e) {
      console.error('Failed to open project desktop:', e)
      markToolUnavailable('desktop')
      setProjectError(t('workbench.project_tool_start_failed', '启动失败'))
    } finally {
      setLoadingTool(null)
      if (shouldClosePanel) {
        onRequestClose?.()
      }
    }
  }

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

  const terminalWindow = activeTerminalSession ? (
    <div
      data-testid={testId('workspace-terminal-window')}
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden',
        showWorkbenchBackground ? 'bg-transparent' : 'bg-background'
      )}
    >
      {!hideTerminalChrome && (
        <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-surface px-2">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {terminalSessions.map(session => {
              const isActive = session.session_id === activeTerminalSession.session_id
              const sessionLabel = getTerminalSessionLabel(session)

              return (
                <div
                  key={session.session_id}
                  className={`group relative flex h-8 max-w-[200px] shrink-0 items-center overflow-hidden rounded-xl border border-transparent transition-colors ${
                    isActive
                      ? 'border-border bg-background text-text-primary shadow-sm'
                      : 'text-text-secondary hover:border-border hover:bg-surface hover:text-text-primary'
                  }`}
                  title={sessionLabel}
                >
                  <button
                    type="button"
                    data-testid={testId('workspace-terminal-tab')}
                    onClick={() => {
                      setActiveTerminalSessionId(session.session_id)
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-sm leading-[18px]"
                  >
                    <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    <span className="truncate">{sessionLabel}</span>
                  </button>
                  <button
                    type="button"
                    data-testid={testId('workspace-terminal-close-button')}
                    onClick={() => handleCloseTerminalSession(session.session_id)}
                    className="pointer-events-none absolute right-1 top-1/2 flex h-[18px] w-[18px] -translate-y-1/2 items-center justify-center rounded-full text-text-secondary opacity-0 transition-colors hover:bg-black/70 hover:text-white focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 group-hover:pointer-events-auto group-hover:opacity-100"
                    aria-label={t('workbench.close_terminal', '关闭终端')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
          </div>
          <WorkspaceAddMenu
            ariaLabel={t('workbench.add_workspace_item')}
            buttonTestId={testId('workspace-terminal-new-tab-button')}
            menuTestId={testId('workspace-terminal-new-tab-menu')}
            items={terminalAddMenuItems}
            buttonClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-50"
          />
        </div>
      )}
      {terminalSessions.map(session => {
        const isActive = session.session_id === activeTerminalSession.session_id

        return session.terminal_kind === 'local' ? (
          <EmbeddedLocalTerminal
            key={session.session_id}
            sessionId={session.session_id}
            active={panelActive && isActive}
            taskId={workspaceTarget?.taskId}
            workspacePath={activeWorkspacePath}
            cwd={session.cwd ?? activeWorkspacePath}
            title={getTerminalSessionLabel(session)}
            onExit={() => handleTerminalSessionExit(session.session_id)}
            onTitleChange={title => handleTerminalTitleChange(session.session_id, title)}
            testIdsEnabled={testIdsEnabled}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        ) : (
          <RemoteTerminal
            key={session.session_id}
            sessionId={session.session_id}
            clientFactory={session.remoteClientFactory}
            active={panelActive && isActive}
            taskId={workspaceTarget?.taskId}
            workspacePath={activeWorkspacePath}
            cwd={session.path ?? session.cwd ?? activeWorkspacePath}
            title={getTerminalSessionLabel(session)}
            onExit={() => handleTerminalSessionExit(session.session_id)}
            onTitleChange={title => handleTerminalTitleChange(session.session_id, title)}
            testIdsEnabled={testIdsEnabled}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        )
      })}
    </div>
  ) : null

  return (
    <div className="relative h-full min-h-0 w-full">
      {terminalWindow}
      {!activeTerminalSession && (
        <div
          data-testid={testId('workspace-tool-launcher')}
          className="flex h-full min-h-0 w-full flex-col"
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
            {projectTerminalAvailable && (
              <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4">
                <button
                  type="button"
                  data-testid={testId('workspace-terminal-card')}
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
                {projectIdeAvailable && (
                  <>
                    {localIdeLaunchable ? (
                      <div
                        data-testid={testId('workspace-ide-card')}
                        className="relative min-h-[132px] rounded-lg bg-surface text-center hover:bg-muted"
                      >
                        <button
                          type="button"
                          data-testid={testId('workspace-ide-primary-button')}
                          onClick={() => void handleIdeClick()}
                          disabled={toolsDisabled || !availableTools.ide}
                          className="flex h-full min-h-[132px] w-full flex-col items-center justify-center rounded-lg px-4 text-center disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {loadingTool === 'ide' ? (
                            <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
                          ) : (
                            <LocalWorkspaceOpenerIcon
                              opener="vscode"
                              className="mb-5 h-7 w-7 rounded-lg"
                            />
                          )}
                          <span className="text-sm font-semibold text-text-primary">
                            {t('workbench.ide', 'IDE')}
                          </span>
                          <span className="mt-2 text-sm leading-[18px] text-text-secondary">
                            {availableTools.ide
                              ? t('workbench.open_project_ide_with', {
                                  opener: 'VS Code',
                                })
                              : t('workbench.project_tool_unavailable', '暂不可用')}
                          </span>
                        </button>
                        <LocalWorkspaceOpenerPicker
                          ariaLabel={t('workbench.choose_project_ide')}
                          buttonTestId={testId('workspace-ide-picker-button')}
                          menuTestId={testId('workspace-ide-picker-menu')}
                          optionTestIdPrefix={testId('workspace-ide-option')}
                          disabled={toolsDisabled || !availableTools.ide}
                          buttonClassName="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                          onSelect={handleIdeClick}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        data-testid={testId('workspace-ide-card')}
                        onClick={() => void handleIdeClick()}
                        disabled={toolsDisabled || !currentProject || !availableTools.ide}
                        className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {loadingTool === 'ide' ? (
                          <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
                        ) : (
                          <LocalWorkspaceOpenerIcon
                            opener="vscode"
                            className="mb-5 h-7 w-7 rounded-lg"
                          />
                        )}
                        <span className="text-sm font-semibold text-text-primary">
                          {t('workbench.ide', 'IDE')}
                        </span>
                        <span className="mt-2 text-sm leading-[18px] text-text-secondary">
                          {availableTools.ide
                            ? t('workbench.open_project_ide', '打开项目 IDE')
                            : t('workbench.project_tool_unavailable', '暂不可用')}
                        </span>
                      </button>
                    )}
                    {cloudToolsAvailable && (
                      <button
                        type="button"
                        data-testid={testId('workspace-desktop-card')}
                        onClick={handleDesktopClick}
                        disabled={
                          toolsDisabled || !activeWorkspaceDeviceId || !availableTools.desktop
                        }
                        className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {loadingTool === 'desktop' ? (
                          <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
                        ) : (
                          <Monitor className="mb-5 h-7 w-7 text-text-secondary" />
                        )}
                        <span className="text-sm font-semibold text-text-primary">
                          {t('workbench.desktop', '桌面')}
                        </span>
                        <span className="mt-2 text-sm leading-[18px] text-text-secondary">
                          {availableTools.desktop
                            ? t('workbench.open_project_desktop', '打开项目桌面')
                            : t('workbench.project_tool_unavailable', '暂不可用')}
                        </span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
