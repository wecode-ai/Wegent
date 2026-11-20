import { useActivityExecutionDisplayStatus } from './useActivityExecutionStatus'
import { useMemo, type ComponentProps } from 'react'
import { createCollaborationTranslator, IssueChatMessage } from '@wegent/collaboration'
import { MarkdownServicesProvider, useMarkdownServices } from '@wegent/collaboration/markdown'
import { useCollaborationMarkdownServices } from './useCollaborationMarkdownServices'
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
  const inherited = useMarkdownServices()
  const markdown = useCollaborationMarkdownServices()
  const services = useMemo(
    () => ({ ...markdown, readMarkdownImage: inherited.readMarkdownImage }),
    [markdown, inherited.readMarkdownImage]
  )
  return (
    <MarkdownServicesProvider value={services}>
      <IssueChatMessage
        {...props}
        showInlineExecutionStatus={
          props.showInlineExecutionStatus &&
          props.message.metadata.execution_dispatch !== 'comment_only'
        }
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
