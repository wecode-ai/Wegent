import { Bot, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatInput } from '@/components/chat/ChatInput'
import { MessageList } from '@/components/chat/MessageList'
import type { Task } from '@/types/api'
import type { WorkbenchMessage } from '@/types/workbench'
import { BottomWorkspacePanel } from './workspace-panels/BottomWorkspacePanel'
import { RightWorkspacePanel } from './workspace-panels/RightWorkspacePanel'
import { WorkspacePanelActions } from './workspace-panels/WorkspacePanelActions'

const DESKTOP_COMPOSER_FRAME_CLASS = 'mx-auto w-[min(90%,62rem)] max-w-full'

interface DesktopWorkbenchMainProps {
  sidebarCollapsed: boolean
  currentTask: Task | null
  messages: WorkbenchMessage[]
  input: string
  isSending: boolean
  onExpandSidebar: () => void
  onInputChange: (value: string) => void
  onSend: () => void
}

export function DesktopWorkbenchMain({
  sidebarCollapsed,
  currentTask,
  messages,
  input,
  isSending,
  onExpandSidebar,
  onInputChange,
  onSend,
}: DesktopWorkbenchMainProps) {
  const { t } = useTranslation('common')
  const [rightPanelOpen, setRightPanelOpen] = useState(false)
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false)
  const hasConversation = messages.length > 0 || currentTask

  return (
    <main className="flex min-w-0 flex-1 overflow-hidden">
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {sidebarCollapsed && (
          <button
            type="button"
            data-testid="expand-sidebar-button"
            onClick={onExpandSidebar}
            className="absolute left-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-[#555] hover:bg-muted"
            aria-label={t('workbench.expand_sidebar', '展开侧边栏')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
        <WorkspacePanelActions
          rightPanelOpen={rightPanelOpen}
          bottomPanelOpen={bottomPanelOpen}
          onToggleRightPanel={() => setRightPanelOpen(open => !open)}
          onToggleBottomPanel={() => setBottomPanelOpen(open => !open)}
        />
        {hasConversation ? (
          <>
            <div className="flex-1 overflow-auto">
              <MessageList messages={messages} />
            </div>
            <div className="px-6 pb-8">
              <div className={DESKTOP_COMPOSER_FRAME_CLASS}>
                <ChatInput
                  value={input}
                  onChange={onInputChange}
                  onSubmit={onSend}
                  disabled={isSending}
                  placeholder={t('workbench.input_placeholder', '尽管问')}
                  variant="desktop"
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-10">
            <div className={DESKTOP_COMPOSER_FRAME_CLASS} data-testid="desktop-empty-composer-frame">
              <div className="mb-8 flex justify-center">
                <Bot className="h-8 w-8 text-text-muted" />
              </div>
              <h1 className="mb-10 text-center text-[34px] font-medium tracking-normal">
                {t('workbench.empty_title', '我们该做什么？')}
              </h1>
              <ChatInput
                value={input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={isSending}
                placeholder={t('workbench.input_placeholder', '尽管问')}
                variant="desktop"
              />
            </div>
          </div>
        )}
        {bottomPanelOpen && <BottomWorkspacePanel onClose={() => setBottomPanelOpen(false)} />}
      </div>
      {rightPanelOpen && (
        <RightWorkspacePanel onClose={() => setRightPanelOpen(false)} />
      )}
    </main>
  )
}
