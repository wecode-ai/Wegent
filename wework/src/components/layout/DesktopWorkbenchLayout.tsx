import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  Plus,
  Search,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-react'
import { useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatInput } from '@/components/chat/ChatInput'
import { MessageList } from '@/components/chat/MessageList'
import type { ProjectWithTasks, Task } from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'

const DEFAULT_SIDEBAR_WIDTH = 280
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 420
const SIDEBAR_WIDTH_STORAGE_KEY = 'wework.desktop.sidebar.width'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onInputChange: (value: string) => void
  onSend: () => void
}

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width))
}

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH

  const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
  const parsedWidth = storedWidth ? Number(storedWidth) : DEFAULT_SIDEBAR_WIDTH

  if (!Number.isFinite(parsedWidth)) {
    return DEFAULT_SIDEBAR_WIDTH
  }

  return clampSidebarWidth(parsedWidth)
}

function storeSidebarWidth(width: number) {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
}

function SidebarButton({
  icon: Icon,
  label,
  testId,
}: {
  icon: typeof Plus
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-[#333] hover:bg-white/70"
    >
      <Icon className="h-4 w-4 text-[#555]" />
      <span>{label}</span>
    </button>
  )
}

function ProjectItem({
  project,
  selected,
  onClick,
}: {
  project: ProjectWithTasks
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid="project-item-button"
      onClick={onClick}
      className={[
        'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm',
        selected ? 'bg-white text-text-primary' : 'text-text-secondary hover:bg-white/70',
      ].join(' ')}
    >
      <Folder className="h-4 w-4 shrink-0" />
      <span className="truncate">{project.name}</span>
    </button>
  )
}

function TaskItem({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="history-task-button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-text-secondary hover:bg-white/70"
    >
      <Clock className="h-4 w-4 shrink-0" />
      <span className="truncate">{task.title}</span>
    </button>
  )
}

export function DesktopWorkbenchLayout({
  state,
  messages,
  onSelectProject,
  onOpenTask,
  onInputChange,
  onSend,
}: DesktopWorkbenchLayoutProps) {
  const { t } = useTranslation('common')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth)
  const hasConversation = messages.length > 0 || state.currentTask

  const handleResizeStart = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      const nextWidth = clampSidebarWidth(moveEvent.clientX)
      setSidebarWidth(nextWidth)
      storeSidebarWidth(nextWidth)
    }

    const handlePointerUp = () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      {!sidebarCollapsed && (
        <aside
          className="relative flex shrink-0 flex-col bg-[#d9dadd] px-4 py-4"
          style={{ width: sidebarWidth }}
        >
          <div className="mb-1 flex justify-end">
            <button
              type="button"
              data-testid="collapse-sidebar-button"
              onClick={() => setSidebarCollapsed(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-[#555] hover:bg-white/70"
              aria-label={t('workbench.collapse_sidebar', '收起侧边栏')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>

          <nav className="space-y-0.5">
            <SidebarButton
              icon={Plus}
              label={t('workbench.new_chat', '新对话')}
              testId="new-chat-button"
            />
            <SidebarButton
              icon={Search}
              label={t('workbench.search', '搜索')}
              testId="search-button"
            />
            <SidebarButton
              icon={Sparkles}
              label={t('workbench.plugins', '插件')}
              testId="plugins-button"
            />
            <SidebarButton
              icon={Workflow}
              label={t('workbench.automation', '自动化')}
              testId="automation-button"
            />
          </nav>

          <section className="mt-8 min-h-0">
            <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">
              {t('workbench.projects', '项目')}
            </h2>
            <div className="space-y-1">
              {state.projects.map(project => (
                <ProjectItem
                  key={project.id}
                  project={project}
                  selected={state.currentProject?.id === project.id}
                  onClick={() => onSelectProject(project.id)}
                />
              ))}
            </div>
          </section>

          <section className="mt-8 min-h-0 flex-1 overflow-hidden">
            <h2 className="mb-3 px-3 text-sm font-semibold text-[#8a8a8a]">
              {t('workbench.history', '对话')}
            </h2>
            <div className="space-y-1 overflow-auto">
              {state.recentTasks.map(task => (
                <TaskItem key={task.id} task={task} onClick={() => onOpenTask(task.id)} />
              ))}
            </div>
          </section>

          <button
            type="button"
            data-testid="settings-button"
            className="mt-4 flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-[#333] hover:bg-white/70"
          >
            <Settings className="h-4 w-4" />
            {t('workbench.settings', '设置')}
          </button>

          <button
            type="button"
            data-testid="sidebar-resize-handle"
            onPointerDown={handleResizeStart}
            className="absolute right-[-4px] top-0 z-20 h-full w-3 cursor-col-resize bg-transparent"
            aria-label={t('workbench.resize_sidebar', '调整侧边栏宽度')}
          />
        </aside>
      )}

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {sidebarCollapsed && (
          <button
            type="button"
            data-testid="expand-sidebar-button"
            onClick={() => setSidebarCollapsed(false)}
            className="absolute left-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-md bg-surface text-[#555] hover:bg-muted"
            aria-label={t('workbench.expand_sidebar', '展开侧边栏')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
        {hasConversation ? (
          <>
            <div className="flex-1 overflow-auto">
              <MessageList messages={messages} />
            </div>
            <div className="mx-auto w-full max-w-4xl px-6 pb-8">
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={state.isSending}
                placeholder={t('workbench.input_placeholder', '尽管问')}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center px-10">
            <div className="w-full max-w-4xl">
              <div className="mb-8 flex justify-center">
                <Bot className="h-8 w-8 text-text-muted" />
              </div>
              <h1 className="mb-10 text-center text-[34px] font-medium tracking-normal">
                {t('workbench.empty_title', '我们该做什么？')}
              </h1>
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={state.isSending}
                placeholder={t('workbench.input_placeholder', '尽管问')}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
