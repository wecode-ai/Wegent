import type { VirtualMessageMeasurement } from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { useDesktopUserMessageServices } from './useDesktopUserMessageServices'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'
function logVirtualMeasurement(details: VirtualMessageMeasurement) {
  console.info('[Wework] Streaming virtual message measured', details)
}
function renderVisualization(
  part: { file: string; mode?: 'wide'; title?: string },
  message: WorkbenchMessage
) {
  return <CodexInlineVisualizationHost {...part} fileChanges={message.fileChanges} />
}

export type DesktopConversationPresentationProp =
  | 'userMessageServices'
  | 'virtualize'
  | 'useContentVisibility'
  | 'onVirtualMeasurement'
  | 'renderVisualization'
export function useDesktopConversationPresentation() {
  const userMessageServices = useDesktopUserMessageServices()
  return {
    userMessageServices,
    virtualize: isDesktopRuntime(),
    useContentVisibility: !isElectronRuntime(),
    onVirtualMeasurement:
      import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1' ? logVirtualMeasurement : undefined,
    renderVisualization,
  }
}
