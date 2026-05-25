import { DesktopWorkbenchLayout } from '@/components/layout/DesktopWorkbenchLayout'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'

export function WorkbenchPage() {
  const isMobile = useIsMobile()
  const { state, messages, selectProject, openTask, setInput, sendCurrentInput } = useWorkbench()

  if (isMobile) {
    return (
      <DesktopWorkbenchLayout
        state={state}
        messages={messages}
        onSelectProject={selectProject}
        onOpenTask={openTask}
        onInputChange={setInput}
        onSend={sendCurrentInput}
      />
    )
  }

  return (
    <DesktopWorkbenchLayout
      state={state}
      messages={messages}
      onSelectProject={selectProject}
      onOpenTask={openTask}
      onInputChange={setInput}
      onSend={sendCurrentInput}
    />
  )
}
