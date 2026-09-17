import { useActivityExecutionDisplayStatus } from './useActivityExecutionStatus'
import type { ComponentProps } from 'react'
import { createCollaborationTranslator, IssueChatMessage } from '@wegent/collaboration'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from '@/components/chat/useDesktopMarkdownServices'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
export type { ExecutionTaskSummary } from '@wegent/collaboration'

function useActivityTranslate() {
  const { i18n } = useTranslation('common')
  return createCollaborationTranslator(i18n.language.startsWith('zh') ? 'zh-CN' : 'en')
}

export function ChatMessage({
  executionTurnId,
  ...props
}: Omit<ComponentProps<typeof IssueChatMessage>, 'translate' | 'onOpenUrl'> & {
  executionTurnId?: string
}) {
  const { status } = useActivityExecutionDisplayStatus(props.message, executionTurnId)
  return (
    <MarkdownServicesProvider value={useDesktopMarkdownServices()}>
      <IssueChatMessage
        {...props}
        executionStatus={status}
        translate={useActivityTranslate()}
        onOpenUrl={url => {
          void openExternalUrl(url).catch(error =>
            console.error('[Wework] Failed to open Wegent task execution', error)
          )
        }}
      />
    </MarkdownServicesProvider>
  )
}
