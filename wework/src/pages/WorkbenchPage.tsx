import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useAuth } from '@/features/auth/useAuth'
import { useIsMobile } from '@/hooks/useIsMobile'
import { navigateTo } from '@/lib/navigation'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { logout } = useAuth()
  const { state, messages, selectProject, openTask, setInput, sendCurrentInput } = useWorkbench()
  const Layout = isMobile ? MobileWorkbenchLayout : DesktopWorkbenchLayout

  return (
    <Layout
      state={state}
      messages={messages}
      onNewChat={() => navigateTo('/')}
      onOpenPlugins={() => navigateTo('/plugins')}
      onSelectProject={selectProject}
      onOpenTask={openTask}
      onInputChange={setInput}
      onSend={sendCurrentInput}
      onLogout={logout}
    />
  )
}
