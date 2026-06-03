import { Bot, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type {
  ProjectChatControls,
  ProjectWorkControls,
} from '@/components/chat/ChatInput'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks, Task } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import type { WorkbenchMessage } from '@/types/workbench'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import { RightWorkspacePanel } from './workspace-panels/RightWorkspacePanel'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'

const DESKTOP_COMPOSER_FRAME_CLASS =
  'mx-auto w-[min(58vw,62rem)] min-w-[32rem] max-w-[calc(100vw-4rem)]'
const DESKTOP_FLOATING_COMPOSER_CLASS =
  'pointer-events-none absolute bottom-4 left-1/2 z-50 w-[min(58vw,62rem)] min-w-[32rem] max-w-[calc(100%_-_3rem)] -translate-x-1/2'

interface DesktopWorkbenchMainProps {
  sidebarCollapsed: boolean
  isBootstrapping: boolean
  currentTask: Task | null
  currentProject: ProjectWithTasks | null
  messages: WorkbenchMessage[]
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  input: string
  isSending: boolean
  environmentInfo: EnvironmentInfo
  onRefreshEnvironmentInfo: () => Promise<void>
  onCommitEnvironmentChanges: (message: string) => Promise<void>
  onExpandSidebar: () => void
  onInputChange: (value: string) => void
  onSend: () => void
}

export function DesktopWorkbenchMain({
  sidebarCollapsed,
  isBootstrapping,
  currentTask,
  currentProject,
  messages,
  projectChat,
  projectWork,
  input,
  isSending,
  environmentInfo,
  onRefreshEnvironmentInfo,
  onCommitEnvironmentChanges,
  onExpandSidebar,
  onInputChange,
  onSend,
}: DesktopWorkbenchMainProps) {
  const { t } = useTranslation('common')
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false)
  const hasConversation = messages.length > 0 || currentTask
  const emptyTitle = currentProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${currentProject.name} 中构建什么？`,
        projectName: currentProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')

  return (
    <main className="relative flex min-w-0 flex-1 overflow-hidden">
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {sidebarCollapsed && (
          <button
            type="button"
            data-testid="expand-sidebar-button"
            onClick={onExpandSidebar}
            className="absolute left-4 top-1 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-text-secondary hover:bg-muted hover:text-text-primary"
            aria-label={t('workbench.expand_sidebar', '展开侧边栏')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
        {isBootstrapping ? (
          <div
            className="flex flex-1"
            data-testid="desktop-workbench-loading"
          />
        ) : hasConversation ? (
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <ScrollableMessageArea
              messages={messages}
              conversationKey={currentTask?.id ?? null}
              className="h-full"
              scrollTestId="desktop-chat-scroll"
              scrollerClassName="pb-40"
            />
            <div
              className={DESKTOP_FLOATING_COMPOSER_CLASS}
              data-testid="desktop-floating-composer-layer"
            >
              <div
                className="pointer-events-auto"
                data-testid="desktop-floating-composer-card"
              >
                <ChatInput
                  value={input}
                  onChange={onInputChange}
                  onSubmit={onSend}
                  disabled={isSending}
                  placeholder={t('workbench.input_placeholder', '尽管问')}
                  variant="desktop"
                  projectChat={projectChat}
                  projectWork={projectWork}
                  showProjectWorkBar={false}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-10">
            <div
              className={DESKTOP_COMPOSER_FRAME_CLASS}
              data-testid="desktop-empty-composer-frame"
            >
              <div className="mb-7 flex justify-center">
                <Bot className="h-7 w-7 text-text-muted" />
              </div>
              <h1 className="mb-9 text-center text-[28px] font-medium leading-9 tracking-normal">
                {emptyTitle}
              </h1>
              <ChatInput
                value={input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={isSending}
                placeholder={t('workbench.input_placeholder', '尽管问')}
                variant="desktop"
                projectChat={projectChat}
                projectWork={projectWork}
              />
            </div>
          </div>
        )}
        {bottomPanelOpen && (
          <BottomWorkspacePanel
            currentProject={currentProject}
            onRequestClose={() => setBottomPanelOpen(false)}
          />
        )}
      </div>
      <WorkspacePanelActions
        environmentInfo={environmentInfo}
        onRefreshEnvironmentInfo={onRefreshEnvironmentInfo}
        onCommitEnvironmentChanges={onCommitEnvironmentChanges}
        rightPanelOpen={rightPanelOpen}
        bottomPanelOpen={bottomPanelOpen}
        onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
        onToggleBottomPanel={() => setBottomPanelOpen((open) => !open)}
      />
      {rightPanelOpen && (
        <RightWorkspacePanel
          currentProject={currentProject}
          onRequestClose={() => setRightPanelOpen(false)}
        />
      )}
    </main>
  )
}
