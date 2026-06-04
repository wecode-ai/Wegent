import { Code2, Loader2, Monitor, Plus, SquareTerminal, X } from 'lucide-react'
import { useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { createProjectApi } from '@/api/projects'
import { getRuntimeConfig } from '@/config/runtime'
import { useTranslation } from '@/hooks/useTranslation'
import { buildVncPageUrl } from '@/lib/vnc'
import type { ProjectDeviceSessionResponse, ProjectWithTasks } from '@/types/api'

interface WorkspacePanelCardsProps {
  currentProject: ProjectWithTasks | null
  onRequestClose?: () => void
}

type WorkspaceTool = 'terminal' | 'ide' | 'desktop'

const SESSION_PROBE_QUERY_KEY = '__wegent_probe'

type WorkspaceToolAvailability = Record<WorkspaceTool, boolean>

interface WorkspaceToolAvailabilityState {
  projectKey: string
  tools: WorkspaceToolAvailability
}

interface WorkspaceToolErrorState {
  projectKey: string
  message: string | null
}

class SessionUrlUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionUrlUnavailableError'
  }
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

function createProjectSessionApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createProjectApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function createDeviceSessionApi() {
  const { apiBaseUrl } = getRuntimeConfig()
  return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

function toEmbeddedSessionUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('embed', '1')
    return parsed.toString()
  } catch {
    return url
  }
}

function toSessionProbeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(SESSION_PROBE_QUERY_KEY, '1')
    return parsed.toString()
  } catch {
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}${SESSION_PROBE_QUERY_KEY}=1`
  }
}

async function probeSessionUrl(url: string): Promise<void> {
  const response = await fetch(toSessionProbeUrl(url), {
    cache: 'no-store',
    credentials: 'omit',
    method: 'GET',
  })
  if (!response.ok) {
    throw new SessionUrlUnavailableError(await response.text())
  }
}

export function WorkspacePanelCards({ currentProject, onRequestClose }: WorkspacePanelCardsProps) {
  const { t } = useTranslation('common')
  const [terminalSessions, setTerminalSessions] = useState<ProjectDeviceSessionResponse[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [loadingTool, setLoadingTool] = useState<WorkspaceTool | null>(null)
  const [toolAvailability, setToolAvailability] = useState<WorkspaceToolAvailabilityState>(
    () => ({
      projectKey: '',
      tools: createAvailableTools(),
    }),
  )
  const [toolError, setToolError] = useState<WorkspaceToolErrorState>({
    projectKey: '',
    message: null,
  })
  const projectDeviceId = getProjectDeviceId(currentProject)
  const projectKey = currentProject ? `${currentProject.id}:${projectDeviceId ?? ''}` : ''
  const availableTools =
    toolAvailability.projectKey === projectKey
      ? toolAvailability.tools
      : createAvailableTools()
  const error = toolError.projectKey === projectKey ? toolError.message : null
  const toolsDisabled = !currentProject || Boolean(loadingTool)
  const activeTerminalSession =
    terminalSessions.find(session => session.session_id === activeTerminalSessionId) ??
    terminalSessions[0] ??
    null

  const markToolUnavailable = (tool: WorkspaceTool) => {
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
  }

  const setProjectError = (message: string | null) => {
    setToolError({ projectKey, message })
  }

  const getSessionStartErrorMessage = (errorValue: unknown): string => {
    if (errorValue instanceof SessionUrlUnavailableError) {
      return t('workbench.project_session_unavailable', '会话已失效，请重新打开工具')
    }
    return t('workbench.project_tool_start_failed', '启动失败')
  }

  const startTerminalSession = async () => {
    if (!currentProject || loadingTool || !availableTools.terminal) return
    setLoadingTool('terminal')
    setProjectError(null)
    try {
      const session = await createProjectSessionApi().startTerminalSession(currentProject.id)
      if (!session.url) {
        throw new SessionUrlUnavailableError('Terminal session URL is missing')
      }
      await probeSessionUrl(session.url)
      setTerminalSessions(sessions => [...sessions, session])
      setActiveTerminalSessionId(session.session_id)
    } catch (e) {
      console.error('Failed to start project terminal:', e)
      markToolUnavailable('terminal')
      setProjectError(getSessionStartErrorMessage(e))
    } finally {
      setLoadingTool(null)
    }
  }

  const handleTerminalClick = () => {
    void startTerminalSession()
  }

  const handleCloseTerminalSession = (sessionId: string) => {
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
        throw new SessionUrlUnavailableError('IDE session URL is missing')
      }
      await probeSessionUrl(session.url)
      window.open(session.url, '_blank', 'noopener')
      shouldClosePanel = true
    } catch (e) {
      console.error('Failed to start project IDE:', e)
      markToolUnavailable('ide')
      setProjectError(getSessionStartErrorMessage(e))
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
      window.open(buildVncPageUrl(projectDeviceId, config.sandbox_id), '_blank', 'noopener')
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

  if (activeTerminalSession) {
    return (
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
                  className={`flex h-8 max-w-[200px] shrink-0 items-center overflow-hidden rounded-md ${
                    isActive ? 'bg-surface text-text-primary' : 'text-text-secondary hover:bg-muted'
                  }`}
                  title={session.device_id}
                >
                  <button
                    type="button"
                    data-testid="workspace-terminal-tab"
                    onClick={() => setActiveTerminalSessionId(session.session_id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-[13px] leading-[18px]"
                  >
                    <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    <span className="truncate">{session.device_id}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="workspace-terminal-close-button"
                    onClick={() => handleCloseTerminalSession(session.session_id)}
                    className="flex h-8 w-7 shrink-0 items-center justify-center text-text-secondary hover:bg-muted"
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
            onClick={() => void startTerminalSession()}
            disabled={loadingTool === 'terminal'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:cursor-wait disabled:opacity-50"
            aria-label={t('workbench.new_terminal_tab', '新建终端标签')}
          >
            {loadingTool === 'terminal' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>
        <iframe
          data-testid="workspace-terminal-frame"
          title={t('workbench.project_terminal_frame_title', '项目终端')}
          src={toEmbeddedSessionUrl(activeTerminalSession.url)}
          className="min-h-0 flex-1 border-0"
        />
      </div>
    )
  }

  return (
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
      </div>
    </div>
  )
}
