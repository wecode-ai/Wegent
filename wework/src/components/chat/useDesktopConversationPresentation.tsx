import type { VirtualMessageMeasurement } from '@wegent/collaboration/conversation'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { isDesktopRuntime, isElectronRuntime } from '@/lib/runtime-environment'
import { useDesktopUserMessageServices } from './useDesktopUserMessageServices'
import { CodexInlineVisualizationHost } from './CodexInlineVisualizationHost'
import { composerSkillFilePath, parseComposerMentions } from './composer/composerMentions'
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
export function useDesktopConversationPresentation(
  messages: WorkbenchMessage[] = [],
  workspacePath?: string
) {
  const hasSkillReferences = messages.some(
    message =>
      message.role === 'user' &&
      parseComposerMentions(message.content).some(
        mention => composerSkillFilePath(mention.reference) !== null
      )
  )
  const userMessageServices = useDesktopUserMessageServices(hasSkillReferences, workspacePath)
  return {
    userMessageServices,
    virtualize: isDesktopRuntime(),
    useContentVisibility: !isElectronRuntime(),
    onVirtualMeasurement:
      import.meta.env.VITE_WEWORK_RUNTIME_DEBUG === '1' ? logVirtualMeasurement : undefined,
    renderVisualization,
  }
}
