import { useState } from 'react'
import type { WorkbenchMessage, WorkbenchState } from '@/types/workbench'
import type { ProjectChatControls, ProjectWorkControls } from '@/components/chat/ChatInput'
import { DesktopSidebar } from './DesktopSidebar'
import { DesktopWorkbenchMain } from './DesktopWorkbenchMain'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'

interface DesktopWorkbenchLayoutProps {
  state: WorkbenchState
  messages: WorkbenchMessage[]
  projectChat: ProjectChatControls
  projectWork: ProjectWorkControls
  onSelectProject: (projectId: number) => void
  onOpenTask: (taskId: number) => void
  onInputChange: (value: string) => void
  onSend: () => void
  onLogout: () => void
}

export function DesktopWorkbenchLayout({
  state,
  messages,
  projectChat,
  projectWork,
  onSelectProject,
  onOpenTask,
  onInputChange,
  onSend,
  onLogout,
}: DesktopWorkbenchLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      {!settingsOpen && !sidebarCollapsed && (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          recentTasks={state.recentTasks}
          currentProjectId={state.currentProject?.id}
          onCollapse={() => setSidebarCollapsed(true)}
          onSelectProject={onSelectProject}
          onOpenTask={onOpenTask}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={onLogout}
        />
      )}

      {settingsOpen ? (
        <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />
      ) : (
        <DesktopWorkbenchMain
          sidebarCollapsed={sidebarCollapsed}
          currentTask={state.currentTask}
          currentProject={state.currentProject}
          messages={messages}
          projectChat={projectChat}
          projectWork={projectWork}
          input={state.input}
          isSending={state.isSending}
          onExpandSidebar={() => setSidebarCollapsed(false)}
          onInputChange={onInputChange}
          onSend={onSend}
        />
      )}
    </div>
  )
}
