import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { logout } = useAuth()
  const { state, messages, projectChat, selectProject, openTask, setInput, sendCurrentInput } =
    useWorkbench()
  const Layout = isMobile ? MobileWorkbenchLayout : DesktopWorkbenchLayout
  const projectWork = {
    projects: state.projects,
    devices: state.devices,
    currentProjectId: state.currentProject?.id,
    onSelectProject: selectProject,
  }

  return (
    <Layout
      state={state}
      messages={messages}
      projectChat={projectChat}
      projectWork={projectWork}
      onSelectProject={selectProject}
      onOpenTask={openTask}
      onInputChange={setInput}
      onSend={sendCurrentInput}
      onLogout={logout}
    />
  )
}
