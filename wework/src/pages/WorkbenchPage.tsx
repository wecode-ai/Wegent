import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { MobileWorkbenchLayout } from '@/components/layout/MobileWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { state, messages, selectProject, openTask, setInput, sendCurrentInput } = useWorkbench()
  const Layout = isMobile ? MobileWorkbenchLayout : DesktopWorkbenchLayout

  return (
    <Layout
      state={state}
      messages={messages}
      onSelectProject={selectProject}
      onOpenTask={openTask}
      onInputChange={setInput}
      onSend={sendCurrentInput}
    />
  )
}
