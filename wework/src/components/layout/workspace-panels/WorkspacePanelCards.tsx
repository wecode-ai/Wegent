import { Code2, Loader2, Monitor, Plus, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { createProjectApi } from '@/api/projects'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { supportsCloudSessions, supportsLocalTerminalLaunch } from '@/lib/device-capabilities'
import { openExternalUrl } from '@/lib/external-links'
import {
  closeLocalTerminal,
  getLocalExecutorDeviceId,
  isLocalTerminalAvailable,
  localPathExists,
  startLocalTerminal,
} from '@/lib/local-terminal'
import { buildVncPageUrl } from '@/lib/vnc'
import type { DeviceInfo, ProjectDeviceSessionResponse, ProjectWithTasks } from '@/types/api'
import { EmbeddedLocalTerminal } from './EmbeddedLocalTerminal'

interface WorkspacePanelCardsProps {
  currentProject: ProjectWithTasks | null
  devices?: DeviceInfo[]
  defaultOpenTool?: WorkspaceTool
  onRequestClose?: () => void
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

type WorkspaceTerminalSession = ProjectDeviceSessionResponse & {
  terminal_kind?: 'cloud' | 'local'
  cwd?: string
}

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
  return project.config?.workspace?.localPath ?? project.config?.path
}

function createProjectSessionApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createProjectApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDeviceSessionApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

export function WorkspacePanelCards({
  currentProject,
  devices = [],
  defaultOpenTool,
  onRequestClose,
}: WorkspacePanelCardsProps) {
  const { t } = useTranslation('common')
  const [terminalSessions, setTerminalSessions] = useState<WorkspaceTerminalSession[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [showToolLauncher, setShowToolLauncher] = useState(false)
  const [loadingTool, setLoadingTool] = useState<WorkspaceTool | null>(null)
  const defaultOpenedProjectKeyRef = useRef<string | null>(null)
  const [toolAvailability, setToolAvailability] = useState<WorkspaceToolAvailabilityState>(() => ({
    projectKey: '',
    tools: createAvailableTools(),
  }))
  const [toolError, setToolError] = useState<WorkspaceToolErrorState>({
    projectKey: '',
    message: null,
  })
  const projectDeviceId = getProjectDeviceId(currentProject)
  const projectLocalPath = currentProject ? getProjectLocalPath(currentProject) : undefined
  const projectDevice = projectDeviceId
    ? devices.find(device => device.device_id === projectDeviceId)
    : undefined
  const localTerminalSupported = Boolean(
    projectDevice && supportsLocalTerminalLaunch(projectDevice)
  )
  const localTerminalRuntimeAvailable = isLocalTerminalAvailable()
  const localTerminalCheckKey = [
    localTerminalRuntimeAvailable ? 'tauri-macos' : 'unavailable',
    projectDevice?.device_id ?? '',
    projectDevice?.device_type ?? '',
    projectDevice?.bind_shell ?? '',
    projectLocalPath ?? '',
  ].join(':')
  const [localTerminalCheck, setLocalTerminalCheck] = useState<LocalTerminalCheckState>({
    key: '',
    executorDeviceId: null,
    pathExists: false,
  })
  const localExecutorDeviceId =
    localTerminalCheck.key === localTerminalCheckKey ? localTerminalCheck.executorDeviceId : null
  const projectLocalPathExists =
    localTerminalCheck.key === localTerminalCheckKey ? localTerminalCheck.pathExists : false
  const cloudToolsAvailable = Boolean(projectDevice && supportsCloudSessions(projectDevice))
  const sameExecutorDevice = Boolean(
    projectDevice && localExecutorDeviceId === projectDevice.device_id
  )
  const localTerminalAvailable = Boolean(
    projectDevice &&
    localTerminalSupported &&
    localTerminalRuntimeAvailable &&
    (sameExecutorDevice || projectLocalPathExists)
  )
  const projectTerminalAvailable = cloudToolsAvailable || localTerminalAvailable
  const hasLimitedProjectTools = Boolean(
    currentProject && projectDeviceId && !cloudToolsAvailable && !localTerminalAvailable
  )
  const projectKey = currentProject ? `${currentProject.id}:${projectDeviceId ?? ''}` : ''
  const availableTools =
    toolAvailability.projectKey === projectKey ? toolAvailability.tools : createAvailableTools()
  const error = toolError.projectKey === projectKey ? toolError.message : null
  const toolsDisabled = !currentProject || Boolean(loadingTool)
  const activeTerminalSession =
    terminalSessions.find(session => session.session_id === activeTerminalSessionId) ??
    terminalSessions[0] ??
    null
  const terminalTabLabel = currentProject?.name ?? activeTerminalSession?.device_id ?? ''

  useEffect(() => {
    if (!localTerminalSupported || !localTerminalRuntimeAvailable) {
      return
    }

    let cancelled = false
    const { apiBaseUrl } = getRuntimeConfig()
    Promise.all([getLocalExecutorDeviceId(apiBaseUrl), localPathExists(projectLocalPath)])
      .then(([deviceId, pathExists]) => {
        if (!cancelled) {
          setLocalTerminalCheck({
            key: localTerminalCheckKey,
            executorDeviceId: deviceId,
            pathExists,
          })
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
    projectLocalPath,
  ])

  const markToolUnavailable = useCallback((tool: WorkspaceTool) => {
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
  }, [projectKey])

  const setProjectError = useCallback((message: string | null) => {
    setToolError({ projectKey, message })
  }, [projectKey])

  const getSessionStartErrorMessage = useCallback(
    () => t('workbench.project_tool_start_failed', '启动失败'),
    [t]
  )

  const startTerminalSession = useCallback(async () => {
    if (!currentProject || loadingTool || !availableTools.terminal) return
    setLoadingTool('terminal')
    setProjectError(null)
    try {
      if (localTerminalAvailable && projectDeviceId) {
        const sessionId = await startLocalTerminal({ cwd: projectLocalPath })
        setTerminalSessions(sessions => [
          ...sessions,
          {
            terminal_kind: 'local',
            session_id: sessionId,
            project_id: currentProject.id,
            device_id: projectDeviceId,
            type: 'terminal',
            path: projectLocalPath ?? '',
            url: '',
            cwd: projectLocalPath,
          },
        ])
        setActiveTerminalSessionId(sessionId)
        setShowToolLauncher(false)
        return
      }

      const session = await createProjectSessionApi().startTerminalSession(currentProject.id)
      if (!session.url) {
        throw new Error('Terminal session URL is missing')
      }
      setTerminalSessions(sessions => [...sessions, session])
      setActiveTerminalSessionId(session.session_id)
      setShowToolLauncher(false)
    } catch (e) {
      console.error('Failed to start project terminal:', e)
      markToolUnavailable('terminal')
      setProjectError(getSessionStartErrorMessage())
    } finally {
      setLoadingTool(null)
    }
  }, [
    availableTools.terminal,
    currentProject,
    getSessionStartErrorMessage,
    loadingTool,
    localTerminalAvailable,
    markToolUnavailable,
    projectDeviceId,
    projectLocalPath,
    setProjectError,
  ])

  useEffect(() => {
    if (
      defaultOpenTool !== 'terminal' ||
      defaultOpenedProjectKeyRef.current === projectKey ||
      terminalSessions.length > 0 ||
      !currentProject ||
      loadingTool ||
      !projectTerminalAvailable ||
      !availableTools.terminal
    ) {
      return
    }

    defaultOpenedProjectKeyRef.current = projectKey
    void startTerminalSession()
  }, [
    availableTools.terminal,
    currentProject,
    defaultOpenTool,
    loadingTool,
    projectKey,
    projectTerminalAvailable,
    startTerminalSession,
    terminalSessions.length,
  ])

  const handleTerminalClick = () => {
    void startTerminalSession()
  }

  const handleCloseTerminalSession = (sessionId: string) => {
    const session = terminalSessions.find(session => session.session_id === sessionId)
    if (session?.terminal_kind === 'local') {
      void closeLocalTerminal(sessionId)
    }

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
  }

  const handleIdeClick = async () => {
    if (!currentProject || loadingTool || !availableTools.ide) return
    setLoadingTool('ide')
    setProjectError(null)
    let shouldClosePanel = false
    try {
      const session = await createProjectSessionApi().startCodeServerSession(currentProject.id)
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
    if (!projectDeviceId || loadingTool || !availableTools.desktop) return
    setLoadingTool('desktop')
    setProjectError(null)
    let shouldClosePanel = false
    try {
      const config = await createDeviceSessionApi().getVncConfig(projectDeviceId)
      if (!config.sandbox_id) {
        throw new Error('Desktop sandbox ID is missing')
      }
      await openExternalUrl(buildVncPageUrl(projectDeviceId, config.sandbox_id))
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

  const terminalWindow = activeTerminalSession ? (
    <div
      data-testid="workspace-terminal-window"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b border-border bg-[#fafafa] px-2">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {terminalSessions.map(session => {
            const isActive = session.session_id === activeTerminalSession.session_id

            return (
              <div
                key={session.session_id}
                className={`group relative flex h-8 max-w-[200px] shrink-0 items-center overflow-hidden rounded-md border border-transparent transition-colors ${
                  isActive
                    ? 'border-border bg-white text-text-primary shadow-sm after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                    : 'text-text-secondary hover:border-border hover:bg-surface hover:text-text-primary'
                }`}
                title={terminalTabLabel || session.device_id}
              >
                <button
                  type="button"
                  data-testid="workspace-terminal-tab"
                  onClick={() => {
                    setActiveTerminalSessionId(session.session_id)
                    setShowToolLauncher(false)
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-[13px] leading-[18px]"
                >
                  <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                  <span className="truncate">{terminalTabLabel || session.device_id}</span>
                </button>
                <button
                  type="button"
                  data-testid="workspace-terminal-close-button"
                  onClick={() => handleCloseTerminalSession(session.session_id)}
                  className="flex h-8 w-7 shrink-0 items-center justify-center text-text-secondary transition-colors group-hover:text-text-primary"
                  aria-label={t('workbench.close_terminal', '关闭终端')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          data-testid="workspace-terminal-new-tab-button"
          onClick={() => setShowToolLauncher(true)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-50"
          aria-label={t('workbench.show_project_tools', '显示项目工具')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {terminalSessions.map(session => {
        const isActive = session.session_id === activeTerminalSession.session_id

        return session.terminal_kind === 'local' ? (
          <EmbeddedLocalTerminal
            key={session.session_id}
            sessionId={session.session_id}
            active={isActive}
          />
        ) : (
          <iframe
            key={session.session_id}
            data-testid="workspace-terminal-frame"
            title={t('workbench.project_terminal_frame_title', '项目终端')}
            src={session.url}
            hidden={!isActive}
            className="h-full min-h-0 w-full flex-1 border-0"
          />
        )
      })}
    </div>
  ) : null
  const launcherClassName = activeTerminalSession
    ? 'absolute inset-0 z-10 flex w-full flex-col bg-white'
    : 'flex h-full min-h-0 w-full flex-col'

  return (
    <div className="relative h-full min-h-0 w-full">
      {terminalWindow}
      {(!activeTerminalSession || showToolLauncher) && (
        <div data-testid="workspace-tool-launcher" className={launcherClassName}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-8 py-6">
            {!currentProject && (
              <p className="text-center text-[13px] leading-[18px] text-text-secondary">
                {t('workbench.project_tool_requires_project', '请选择项目后使用')}
              </p>
            )}
            {error && (
              <p className="text-center text-[13px] leading-[18px] text-red-500" role="alert">
                {error}
              </p>
            )}
            {hasLimitedProjectTools && (
              <div
                data-testid="workspace-local-device-limited-tools"
                className="rounded-lg border border-border bg-surface px-4 py-5 text-center"
              >
                <p className="text-sm font-semibold text-text-primary">
                  {t('workbench.local_device_limited_tools_title')}
                </p>
                <p className="mt-2 text-[13px] leading-[18px] text-text-secondary">
                  {t('workbench.local_device_limited_tools_desc')}
                </p>
              </div>
            )}
            {projectTerminalAvailable && (
              <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4">
                <button
                  type="button"
                  data-testid="workspace-terminal-card"
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
                  <span className="mt-2 text-[13px] leading-[18px] text-text-secondary">
                    {availableTools.terminal
                      ? t('workbench.start_shell', '启动交互式 shell')
                      : t('workbench.project_tool_unavailable', '暂不可用')}
                  </span>
                </button>
                {cloudToolsAvailable && (
                  <>
                    <button
                      type="button"
                      data-testid="workspace-ide-card"
                      onClick={handleIdeClick}
                      disabled={toolsDisabled || !availableTools.ide}
                      className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {loadingTool === 'ide' ? (
                        <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
                      ) : (
                        <Code2 className="mb-5 h-7 w-7 text-text-secondary" />
                      )}
                      <span className="text-sm font-semibold text-text-primary">
                        {t('workbench.ide', 'IDE')}
                      </span>
                      <span className="mt-2 text-[13px] leading-[18px] text-text-secondary">
                        {availableTools.ide
                          ? t('workbench.open_project_ide', '打开项目 IDE')
                          : t('workbench.project_tool_unavailable', '暂不可用')}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid="workspace-desktop-card"
                      onClick={handleDesktopClick}
                      disabled={toolsDisabled || !projectDeviceId || !availableTools.desktop}
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
                      <span className="mt-2 text-[13px] leading-[18px] text-text-secondary">
                        {availableTools.desktop
                          ? t('workbench.open_project_desktop', '打开项目桌面')
                          : t('workbench.project_tool_unavailable', '暂不可用')}
                      </span>
                    </button>
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
