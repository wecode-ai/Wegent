import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { PluginManagementWorkspace } from '@/components/plugins/PluginManagementWorkspace'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { navigateTo } from '@/lib/navigation'

export function PluginManagementPage() {
  const { logout } = useAuth()
  const { state, selectProject, openTask } = useWorkbench()

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }

  const handleOpenTask = (taskId: number) => {
    navigateTo('/')
    void openTask(taskId)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-base text-text-primary">
      <DesktopSidebar
        user={state.user}
        projects={state.projects}
        recentTasks={state.recentTasks}
        currentProjectId={state.currentProject?.id}
        activeItem="plugins"
        onCollapse={() => {}}
        onNewChat={() => navigateTo('/')}
        onSelectProject={handleSelectProject}
        onOpenTask={handleOpenTask}
        onOpenPlugins={() => navigateTo('/plugins')}
        onLogout={logout}
      />
      <PluginManagementWorkspace />
    </div>
  )
}
