import { SquareTerminal, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { WorkspaceTarget } from '@/types/workspace-files'
import { EmbeddedLocalTerminal } from './EmbeddedLocalTerminal'
import { RemoteTerminal } from './RemoteTerminal'
import { WorkspaceAddMenu, type WorkspaceAddMenuItem } from './WorkspaceAddMenu'
import { getTerminalSessionLabel, type WorkspaceTerminalSession } from './workspace-panel-tools'

interface WorkspaceTerminalWindowProps {
  showWorkbenchBackground: boolean
  hideTerminalChrome: boolean
  panelActive: boolean
  testIdsEnabled: boolean
  terminalSessions: WorkspaceTerminalSession[]
  activeTerminalSession: WorkspaceTerminalSession
  workspaceTarget: WorkspaceTarget | null
  activeWorkspacePath?: string
  terminalAddMenuItems: WorkspaceAddMenuItem[]
  onSelectTerminalSession: (sessionId: string) => void
  onCloseTerminalSession: (sessionId: string) => void
  onTerminalSessionExit: (sessionId: string) => void
  onTerminalTitleChange: (sessionId: string, title: string) => void
}

export function WorkspaceTerminalWindow({
  showWorkbenchBackground,
  hideTerminalChrome,
  panelActive,
  testIdsEnabled,
  terminalSessions,
  activeTerminalSession,
  workspaceTarget,
  activeWorkspacePath,
  terminalAddMenuItems,
  onSelectTerminalSession,
  onCloseTerminalSession,
  onTerminalSessionExit,
  onTerminalTitleChange,
}: WorkspaceTerminalWindowProps) {
  const { t } = useTranslation('common')
  const testId = (value: string) => (testIdsEnabled ? value : undefined)

  return (
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
                    onClick={() => onSelectTerminalSession(session.session_id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-sm leading-[18px]"
                  >
                    <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    <span className="truncate">{sessionLabel}</span>
                  </button>
                  <button
                    type="button"
                    data-testid={testId('workspace-terminal-close-button')}
                    onClick={() => onCloseTerminalSession(session.session_id)}
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
            onExit={() => onTerminalSessionExit(session.session_id)}
            onTitleChange={title => onTerminalTitleChange(session.session_id, title)}
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
            onExit={() => onTerminalSessionExit(session.session_id)}
            onTitleChange={title => onTerminalTitleChange(session.session_id, title)}
            testIdsEnabled={testIdsEnabled}
            showWorkbenchBackground={showWorkbenchBackground}
          />
        )
      })}
    </div>
  )
}
