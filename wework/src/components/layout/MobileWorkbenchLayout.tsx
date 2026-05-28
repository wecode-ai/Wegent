import { Bot, Code2, Folder, Image, Menu, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { ChatInput } from '@/components/chat/ChatInput'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import { useTranslation } from '@/hooks/useTranslation'
import { MessageList } from '@/components/chat/MessageList'
import type { ArchivedTaskListResponse, CreateProjectRequest, ProjectWithTasks } from '@/types/api'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { MobileDrawer } from './MobileDrawer'

interface MobileWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat?: () => void
  onOpenPlugins?: () => void
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number) => void
  onStartNewProjectChat?: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onCreateProject?: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onUpdateProjectName?: (projectId: number, name: string) => Promise<void>
  onRemoveProject?: (projectId: number) => Promise<void>
  onArchiveAllChats?: () => Promise<void>
  onArchiveProjectChats?: (projectId: number) => Promise<void>
  onArchiveTask?: (taskId: number) => Promise<void>
  onRenameTask?: (taskId: number, title: string) => Promise<void>
  onListArchivedTasks?: () => Promise<ArchivedTaskListResponse>
  onUnarchiveTask?: (taskId: number) => Promise<void>
  onDeleteTask?: (taskId: number) => Promise<void>
  onDeleteArchivedTasks?: () => Promise<void>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onInputChange: (value: string) => void
  onSend: () => void
  onLogout: () => void
}

function QuickEntry({
  icon: Icon,
  label,
  testId,
}: {
  icon: typeof Folder
  label: string
  testId: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="flex h-11 min-w-[44px] items-center gap-2 rounded-full bg-surface px-4 text-sm font-medium text-text-primary"
    >
      <Icon className="h-4 w-4 text-text-secondary" />
      <span>{label}</span>
    </button>
  )
}

export function MobileWorkbenchLayout({
  state,
  messages,
  projectChat,
  projectWork,
  onSelectProject,
  onOpenTask,
  onInputChange,
  onSend,
}: MobileWorkbenchLayoutProps) {
  const { t } = useTranslation('common')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const hasConversation = messages.length > 0 || state.currentTask
  const emptyTitle = state.currentProject
    ? t('workbench.project_empty_title', {
        defaultValue: `我们应该在 ${state.currentProject.name} 中构建什么？`,
        projectName: state.currentProject.name,
      })
    : t('workbench.empty_title', '我们该做什么？')

  return (
    <div className="flex min-h-screen bg-base text-text-primary">
      <main className="flex min-h-screen w-full flex-col overflow-hidden">
        {hasConversation ? (
          <>
            <header className="flex items-center justify-between px-4 pb-3 pt-[max(16px,env(safe-area-inset-top))]">
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-6 w-6" />
              </button>
              <h1 className="min-w-0 flex-1 truncate px-4 text-center text-base font-semibold">
                {state.currentTask?.title ||
                  state.currentProject?.name ||
                  t('workbench.brand', 'Wework')}
              </h1>
              <div className="h-11 min-w-[44px]" />
            </header>
            <div className="min-h-0 flex-1 overflow-auto">
              <MessageList messages={messages} />
            </div>
            <div className="px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={state.isSending}
                placeholder={t('workbench.mobile_input_placeholder', '询问 Wework')}
                projectChat={projectChat}
                projectWork={projectWork}
              />
            </div>
          </>
        ) : (
          <div className="flex min-h-screen flex-col px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))]">
            <header className="flex items-center justify-between">
              <button
                type="button"
                data-testid="open-mobile-drawer-button"
                onClick={() => setDrawerOpen(true)}
                className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-surface"
                aria-label={t('workbench.open_menu', '打开菜单')}
              >
                <Menu className="h-6 w-6" />
              </button>
              <div className="flex h-11 min-w-[44px] items-center justify-center rounded-full bg-[#9b59b6] text-sm font-medium text-white">
                {state.user?.user_name?.slice(0, 2).toUpperCase() ||
                  t('workbench.user_fallback', '我')}
              </div>
            </header>

            <section className="flex flex-1 flex-col justify-end pb-5">
              <div className="mb-10 flex justify-center">
                <Bot className="h-8 w-8 text-text-muted" />
              </div>
              <h1 className="mb-8 text-center text-2xl font-semibold tracking-normal">
                {emptyTitle}
              </h1>
              <div className="mb-5 flex flex-wrap justify-center gap-3">
                <QuickEntry
                  icon={Folder}
                  label={t('workbench.quick_project_work', '项目工作')}
                  testId="mobile-projects-quick-entry-button"
                />
                <QuickEntry
                  icon={Image}
                  label={t('workbench.quick_search', '查找资料')}
                  testId="mobile-images-quick-entry-button"
                />
                <QuickEntry
                  icon={Code2}
                  label={t('workbench.quick_new_task', '新任务')}
                  testId="mobile-code-quick-entry-button"
                />
                <QuickEntry
                  icon={MoreHorizontal}
                  label={t('workbench.more', '更多')}
                  testId="mobile-more-quick-entry-button"
                />
              </div>
              <ChatInput
                value={state.input}
                onChange={onInputChange}
                onSubmit={onSend}
                disabled={state.isSending}
                placeholder={t('workbench.mobile_input_placeholder', '询问 Wework')}
                projectChat={projectChat}
                projectWork={projectWork}
              />
            </section>
          </div>
        )}
      </main>

      <MobileDrawer
        open={drawerOpen}
        user={state.user}
        projects={state.projects}
        recentTasks={state.recentTasks}
        onClose={() => setDrawerOpen(false)}
        onSelectProject={onSelectProject}
        onOpenTask={onOpenTask}
      />
    </div>
  )
}
