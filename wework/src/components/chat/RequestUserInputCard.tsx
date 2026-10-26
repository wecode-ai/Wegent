import type { ComponentProps } from 'react'
import {
  RequestUserInputCard as SharedRequestUserInputCard,
  RequestUserInputSummary as SharedRequestUserInputSummary,
} from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'
import { openExternalUrl } from '@/lib/external-links'
import type { WorkbenchMessage } from '@/types/workbench'
import { useTranslation } from '@/hooks/useTranslation'
import { isRequestUserInputBlock, requestUserInputPayloadKey } from './requestUserInputMessages'
export type { RequestUserInputPayload } from '@wegent/chat-core/runtime'

export function RequestUserInputCard({
  messages,
  ...props
}: ComponentProps<typeof SharedRequestUserInputCard> & { messages?: WorkbenchMessage[] }) {
  const { t } = useTranslation('common')
  const question = props.payload.questions?.[0]
  const questionId = question?.id
  const callId = questionId?.startsWith('mcp_tool_call_approval_')
    ? questionId.slice('mcp_tool_call_approval_'.length)
    : undefined
  const requestKey = requestUserInputPayloadKey(props.payload)
  const owner =
    requestKey && messages
      ? [...messages]
          .reverse()
          .find(message =>
            message.blocks?.some(
              block =>
                isRequestUserInputBlock(block) &&
                requestUserInputPayloadKey(block.renderPayload) === requestKey
            )
          )
      : undefined
  const reply =
    callId &&
    owner?.blocks?.find(
      block =>
        block.id === callId && block.type === 'tool' && block.toolName === 'wework_stand_in.reply'
    )
  const text = reply && reply.type === 'tool' && reply.toolInput?.text
  const payload =
    typeof text === 'string' && props.payload.questions?.length === 1 && question
      ? {
          ...props.payload,
          questions: [
            {
              ...question,
              header: t('standIn.workspace.confirm_reply'),
              question: text,
              options: question.options?.map(option => ({
                ...option,
                value: option.value ?? option.label,
                label:
                  option.label === 'Allow'
                    ? t('standIn.workspace.send_reply')
                    : ['Cancel', 'Decline'].includes(option.label ?? '')
                      ? t('standIn.workspace.decline_reply')
                      : option.label,
                description: undefined,
              })),
            },
          ],
        }
      : props.payload
  return (
    <DesktopConversationTranslation>
      <SharedRequestUserInputCard
        {...props}
        payload={payload}
        onOpenAuthorizationUrl={url => openExternalUrl(url, { target: 'system' })}
      />
    </DesktopConversationTranslation>
  )
}

export function RequestUserInputSummary(
  props: ComponentProps<typeof SharedRequestUserInputSummary>
) {
  return (
    <DesktopConversationTranslation>
      <SharedRequestUserInputSummary {...props} />
    </DesktopConversationTranslation>
  )
}
