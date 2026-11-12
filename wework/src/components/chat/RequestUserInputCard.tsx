import { useContext, type ComponentProps } from 'react'
import { MessageCircle } from 'lucide-react'
import type { RuntimeTaskAddress } from '@/types/api'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import {
  canDiscussQuestion,
  questionDiscussionKey,
  questionDiscussionDrafts,
  QuestionDiscussionStoreContext,
  useQuestionDiscussion,
} from '@/features/notifications/questionDiscussion'
import { requestUserInputQuestionTarget } from '@/components/layout/requestUserInputOverlay'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import {
  RequestUserInputCard as SharedRequestUserInputCard,
  RequestUserInputSummary as SharedRequestUserInputSummary,
  useToolInteractionServices,
} from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'
import { openExternalUrl } from '@/lib/external-links'
import type { WorkbenchMessage } from '@/types/workbench'
import { useTranslation } from '@/hooks/useTranslation'
import {
  isRequestUserInputBlock,
  requestUserInputPayloadKey,
  isImplementationPlanRequestUserInput,
} from './requestUserInputMessages'
export type { RequestUserInputPayload } from '@wegent/chat-core/runtime'

function nativeApprovalArguments(payload: RequestUserInputPayload, title: string) {
  return payload.serverName === 'wework_stand_in' &&
    payload.approvalKind === 'mcp_tool_call' &&
    payload.toolTitle === title &&
    payload.interactionKind === 'mcp_form' &&
    payload.interactionStatus === 'pending' &&
    payload.questions?.[0]?.id === '__mcp_approval'
    ? payload.toolArguments
    : undefined
}

function nativeSourceReplyApproval(payload: RequestUserInputPayload) {
  const input = nativeApprovalArguments(payload, 'Wework: Reply to source')
  return payload.toolName === 'reply' &&
    input &&
    ['messageId', 'text'].every(key => typeof input[key] === 'string' && input[key].trim())
    ? input
    : undefined
}

function nativeEmailApproval(payload: RequestUserInputPayload) {
  const input = nativeApprovalArguments(payload, 'Wework: Send email')
  return input &&
    ['from', 'to', 'subject', 'text'].every(
      key => typeof input[key] === 'string' && input[key].trim()
    )
    ? input
    : undefined
}

function nativeGitWebhookApproval(payload: RequestUserInputPayload) {
  const input = nativeApprovalArguments(payload, 'Configure repository webhook')
  return input &&
    ['instance', 'repository', 'callbackUrl', 'subscriptionId'].every(
      key => typeof input[key] === 'string' && input[key].trim()
    ) &&
    Array.isArray(input.events) &&
    input.events.length > 0 &&
    input.events.every(event => typeof event === 'string' && event.trim())
    ? input
    : undefined
}

function nativeGitApproval(payload: RequestUserInputPayload) {
  const input = nativeApprovalArguments(payload, 'Publish GitHub/GitLab change')
  return input &&
    ['instance', 'accountId', 'repository', 'method', 'path'].every(
      key => typeof input[key] === 'string' && input[key].trim()
    ) &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(input.method)) &&
    input.body &&
    typeof input.body === 'object' &&
    !Array.isArray(input.body)
    ? input
    : undefined
}

export function RequestUserInputCard({
  messages,
  source,
  ...props
}: ComponentProps<typeof SharedRequestUserInputCard> & {
  messages?: WorkbenchMessage[]
  source?: RuntimeTaskAddress | null
}) {
  const { t } = useTranslation('common')
  const pane = useContext(WorkbenchContext)
  const discussion = useQuestionDiscussion()
  const store = useContext(QuestionDiscussionStoreContext)
  const toolServices = useToolInteractionServices()
  const address =
    source === undefined
      ? (toolServices.requestUserInputSource ?? pane?.state.currentRuntimeTask)
      : source
  const discussionKey = address ? questionDiscussionKey(address, props.payload) : null
  const draftAnswers =
    store && address
      ? {
          ...props.draftAnswers,
          ...questionDiscussionDrafts(store.sessions, address, props.payload),
        }
      : props.draftAnswers
  const canDiscuss = Boolean(
    discussion && address && props.onSubmit && canDiscussQuestion(props.payload)
  )
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
        block.id === callId &&
        block.type === 'tool' &&
        ['wework_stand_in.reply', 'wework_stand_in.send_email'].includes(block.toolName ?? '')
    )
  const email =
    nativeEmailApproval(props.payload) ??
    (reply && reply.type === 'tool' && reply.toolName === 'wework_stand_in.send_email'
      ? reply.toolInput
      : undefined)
  const sourceReply = nativeSourceReplyApproval(props.payload)
  const text =
    email?.text ?? sourceReply?.text ?? (reply && reply.type === 'tool' && reply.toolInput?.text)
  const git = nativeGitApproval(props.payload)
  const webhook = nativeGitWebhookApproval(props.payload)
  const preview = git
    ? t('standIn.git.write_preview', {
        instance: git.instance,
        accountId: git.accountId,
        repository: git.repository,
        method: git.method,
        path: git.path,
        body: JSON.stringify(git.body, null, 2),
      })
    : webhook
      ? t('standIn.git.webhook_write_preview', {
          instance: webhook.instance,
          repository: webhook.repository,
          callback: webhook.callbackUrl,
          subscriptionId: webhook.subscriptionId,
          events: JSON.stringify(webhook.events),
        })
      : email && typeof text === 'string'
        ? t('standIn.email.preview', {
            from: email.from,
            to: email.to,
            subject: email.subject,
            body: text,
          })
        : sourceReply
          ? t('standIn.workspace.reply_preview', { body: text })
          : text
  const payload =
    typeof preview === 'string' && props.payload.questions?.length === 1 && question
      ? {
          ...props.payload,
          questions: [
            {
              ...question,
              header: t(
                webhook
                  ? 'standIn.git.confirm_webhook'
                  : git
                    ? 'standIn.git.confirm_write'
                    : email
                      ? 'standIn.email.confirm_send'
                      : 'standIn.workspace.confirm_reply'
              ),
              question: preview,
              options: question.options?.map(option => ({
                ...option,
                value: option.value ?? option.label,
                label:
                  option.label === 'Allow'
                    ? t(
                        git || webhook
                          ? 'standIn.git.approve_write'
                          : 'standIn.workspace.send_reply'
                      )
                    : ['Cancel', 'Decline'].includes(option.label ?? '')
                      ? t(
                          git || webhook
                            ? 'standIn.git.decline_write'
                            : 'standIn.workspace.decline_reply'
                        )
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
        payload={
          canDiscuss && !isImplementationPlanRequestUserInput(payload)
            ? {
                ...payload,
                questions: payload.questions?.map(question => ({
                  ...question,
                  isOther: true,
                  is_other: true,
                })),
              }
            : payload
        }
        draftAnswers={draftAnswers}
        onDraftAnswersChange={answers => {
          props.onDraftAnswersChange?.(answers)
          if (store && address && discussionKey && canDiscuss) {
            for (const [questionId, answer] of Object.entries(answers)) {
              const target = requestUserInputQuestionTarget(props.payload, questionId)
              store.update(questionDiscussionKey(address, target.payload), current => ({
                ...current,
                source: address,
                payload: current?.payload ?? target.payload,
                address: current?.address ?? null,
                answers: { ...current?.answers, [target.questionId]: answer },
              }))
            }
          }
        }}
        additionalActions={
          canDiscuss ? (
            <button
              type="button"
              data-testid="request-user-input-discuss"
              disabled={props.disabled}
              onClick={() => discussion!.open(address!, props.payload)}
              className="mr-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus disabled:opacity-50 md:min-h-8"
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
              {t('question_discussion.open')}
            </button>
          ) : (
            props.additionalActions
          )
        }
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
