import { useState } from 'react'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import { DesktopSidebar } from './DesktopSidebar'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  activeItem?: 'chat' | 'plugins' | 'automation'
  onNewChat: () => void
  onOpenPlugins: () => void
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onInputChange: (value: string) => void
  onSend: () => void
  onLogout: () => void
}

export function DesktopWorkbenchLayout({
  state,
  messages,
  activeItem = 'chat',
  onNewChat,
  onOpenPlugins,
  onSelectProject,
  onOpenTask,
  onInputChange,
  onSend,
  onLogout,
}: DesktopWorkbenchLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      {!sidebarCollapsed && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          recentTasks={state.recentTasks}
          currentProjectId={state.currentProject?.id}
          activeItem={activeItem}
          onCollapse={() => setSidebarCollapsed(true)}
          onNewChat={onNewChat}
          onSelectProject={onSelectProject}
          onOpenTask={onOpenTask}
          onOpenPlugins={onOpenPlugins}
          onLogout={onLogout}
        />
      )}

      <DesktopWorkbenchMain
        sidebarCollapsed={sidebarCollapsed}
        currentTask={state.currentTask}
        messages={messages}
        input={state.input}
        isSending={state.isSending}
        onExpandSidebar={() => setSidebarCollapsed(false)}
        onInputChange={onInputChange}
        onSend={onSend}
      />
    </div>
  )
}
