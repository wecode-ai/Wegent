import { Code2, Loader2, Monitor, Plus, SquareTerminal, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { createProjectApi } from '@/api/projects'
import { getRuntimeConfig } from '@/config/runtime'
import { buildVncPageUrl } from '@/lib/vnc'
import type { ProjectDeviceSessionResponse, ProjectWithTasks } from '@/types/api'

interface WorkspacePanelCardsProps {
  currentProject: ProjectWithTasks | null
  onRequestClose?: () => void
}

type WorkspaceTool = 'terminal' | 'ide' | 'desktop'

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

export function WorkspacePanelCards({ currentProject, onRequestClose }: WorkspacePanelCardsProps) {
  const { t } = useTranslation('common')
  const [terminalSessions, setTerminalSessions] = useState<ProjectDeviceSessionResponse[]>([])
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null)
  const [loadingTool, setLoadingTool] = useState<WorkspaceTool | null>(null)
  const [error, setError] = useState<string | null>(null)
  const projectDeviceId = getProjectDeviceId(currentProject)
  const toolsDisabled = !currentProject || Boolean(loadingTool)
  const activeTerminalSession =
    terminalSessions.find(session => session.session_id === activeTerminalSessionId) ??
    terminalSessions[0] ??
    null

  const startTerminalSession = async () => {
    if (!currentProject || loadingTool) return
    setLoadingTool('terminal')
    setError(null)
    try {
      const session = await createProjectSessionApi().startTerminalSession(currentProject.id)
      setTerminalSessions(sessions => [...sessions, session])
      setActiveTerminalSessionId(session.session_id)
    } catch (e) {
      console.error('Failed to start project terminal:', e)
      setError(t('workbench.project_tool_start_failed', '启动失败'))
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
    if (!currentProject || loadingTool) return
    setLoadingTool('ide')
    setError(null)
    let shouldClosePanel = false
    try {
      const session = await createProjectSessionApi().startCodeServerSession(currentProject.id)
      if (session.url) {
        window.open(session.url, '_blank', 'noopener')
        shouldClosePanel = true
      }
    } catch (e) {
      console.error('Failed to start project IDE:', e)
      setError(t('workbench.project_tool_start_failed', '启动失败'))
    } finally {
      setLoadingTool(null)
      if (shouldClosePanel) {
        onRequestClose?.()
      }
    }
  }

  const handleDesktopClick = async () => {
    if (!projectDeviceId || loadingTool) return
    setLoadingTool('desktop')
    setError(null)
    let shouldClosePanel = false
    try {
      const config = await createDeviceSessionApi().getVncConfig(projectDeviceId)
      window.open(buildVncPageUrl(projectDeviceId, config.sandbox_id), '_blank', 'noopener')
      shouldClosePanel = true
    } catch (e) {
      console.error('Failed to open project desktop:', e)
      setError(t('workbench.project_tool_start_failed', '启动失败'))
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
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-sm"
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
        <p className="text-center text-sm text-text-secondary">
          {t('workbench.project_tool_requires_project', '请选择项目后使用')}
        </p>
      )}
      {error && (
        <p className="text-center text-sm text-red-500" role="alert">
          {error}
        </p>
      )}
      <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-4">
        <button
          type="button"
          data-testid="workspace-terminal-card"
          onClick={handleTerminalClick}
          disabled={toolsDisabled}
          className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingTool === 'terminal' ? (
            <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
          ) : (
            <SquareTerminal className="mb-5 h-7 w-7 text-text-secondary" />
          )}
          <span className="text-base font-semibold text-text-primary">
            {t('workbench.terminal', '终端')}
          </span>
          <span className="mt-2 text-sm text-text-secondary">
            {t('workbench.start_shell', '启动交互式 shell')}
          </span>
        </button>
        <button
          type="button"
          data-testid="workspace-ide-card"
          onClick={handleIdeClick}
          disabled={toolsDisabled}
          className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingTool === 'ide' ? (
            <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
          ) : (
            <Code2 className="mb-5 h-7 w-7 text-text-secondary" />
          )}
          <span className="text-base font-semibold text-text-primary">
            {t('workbench.ide', 'IDE')}
          </span>
          <span className="mt-2 text-sm text-text-secondary">
            {t('workbench.open_project_ide', '打开项目 IDE')}
          </span>
        </button>
        <button
          type="button"
          data-testid="workspace-desktop-card"
          onClick={handleDesktopClick}
          disabled={toolsDisabled || !projectDeviceId}
          className="flex min-h-[132px] flex-col items-center justify-center rounded-lg bg-surface text-center hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loadingTool === 'desktop' ? (
            <Loader2 className="mb-5 h-7 w-7 animate-spin text-text-secondary" />
          ) : (
            <Monitor className="mb-5 h-7 w-7 text-text-secondary" />
          )}
          <span className="text-base font-semibold text-text-primary">
            {t('workbench.desktop', '桌面')}
          </span>
          <span className="mt-2 text-sm text-text-secondary">
            {t('workbench.open_project_desktop', '打开项目桌面')}
          </span>
        </button>
      </div>
    </div>
  )
}
