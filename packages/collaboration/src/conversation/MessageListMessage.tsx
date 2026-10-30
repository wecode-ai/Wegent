import { memo, type ComponentProps, type Dispatch, type SetStateAction } from 'react'
import type {
  RuntimeConversationTurn,
  WorkbenchMessage,
} from '@wegent/chat-core/runtime-conversation'
import { AssistantMessage } from './AssistantMessage'
import { UserMessage } from './UserMessage'
import type { MessageListProps } from './MessageList'

type MessageListMessageProps = Pick<
  MessageListProps,
  | 'userMessageServices'
  | 'renderVisualization'
  | 'conversationKey'
  | 'onBeforeUserMessageToggle'
  | 'onOpenWorkspaceFile'
  | 'onOpenLocalSkillFile'
  | 'onEditLastUserMessage'
  | 'onRetryFailedMessage'
  | 'onSwitchModelForFailedMessage'
  | 'onLoadFileChangesDiff'
  | 'onRevertFileChanges'
  | 'onOpenFileChangesReview'
  | 'fileChangesDiffPreviewDisabledSubtaskId'
  | 'onRequestUserInputSubmit'
  | 'onRequestUserInputIgnore'
  | 'onOpenAssistantPlan'
  | 'onOpenSubagent'
  | 'hideRequestUserInputBlocks'
  | 'hiddenRequestUserInputIds'
  | 'onForkMessage'
> & {
  devices: NonNullable<MessageListProps['devices']>
  message: WorkbenchMessage
  runtimeTurn?: RuntimeConversationTurn
  forceExpanded: boolean
  isActiveTurn: boolean
  replyQuestions: ComponentProps<typeof UserMessage>['replyQuestions']
  editable: boolean
  editing: boolean
  editSubmitting: boolean
  setEditingMessageId: Dispatch<SetStateAction<string | null>>
  setSubmittingEditMessageId: Dispatch<SetStateAction<string | null>>
}

// Virtual coordinates change independently of message content. Keep scroll commits
// outside the body while retaining React's default comparison of every input.
export const MessageListMessage = memo(function MessageListMessage({
  message,
  runtimeTurn,
  forceExpanded,
  isActiveTurn,
  userMessageServices,
  renderVisualization,
  conversationKey,
  devices,
  replyQuestions,
  editable,
  editing,
  editSubmitting,
  setEditingMessageId,
  setSubmittingEditMessageId,
  onBeforeUserMessageToggle,
  onOpenWorkspaceFile,
  onOpenLocalSkillFile,
  onEditLastUserMessage,
  onRetryFailedMessage,
  onSwitchModelForFailedMessage,
  onLoadFileChangesDiff,
  onRevertFileChanges,
  onOpenFileChangesReview,
  fileChangesDiffPreviewDisabledSubtaskId,
  onRequestUserInputSubmit,
  onRequestUserInputIgnore,
  onOpenAssistantPlan,
  onOpenSubagent,
  hideRequestUserInputBlocks,
  hiddenRequestUserInputIds,
  onForkMessage,
}: MessageListMessageProps) {
  return message.role === 'user' ? (
    <UserMessage
      services={userMessageServices}
      message={message}
      forceExpanded={forceExpanded}
      replyQuestions={replyQuestions}
      onBeforeToggle={onBeforeUserMessageToggle}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      onOpenLocalSkillFile={onOpenLocalSkillFile}
      editable={editable}
      editing={editing}
      editSubmitting={editSubmitting}
      onStartEdit={() => setEditingMessageId(message.id)}
      onCancelEdit={() => setEditingMessageId(null)}
      onSubmitEdit={async content => {
        if (!onEditLastUserMessage) return false
        setSubmittingEditMessageId(message.id)
        try {
          const result = await onEditLastUserMessage(message, content)
          if (result !== false) setEditingMessageId(null)
          return result
        } finally {
          setSubmittingEditMessageId(current => (current === message.id ? null : current))
        }
      }}
    />
  ) : (
    <AssistantMessage
      forceExpanded={forceExpanded}
      imageServices={userMessageServices.images}
      renderVisualization={renderVisualization}
      message={message}
      runtimeTurn={runtimeTurn}
      conversationKey={conversationKey}
      isActiveTurn={isActiveTurn}
      devices={devices}
      onRetryFailedMessage={onRetryFailedMessage}
      onSwitchModelForFailedMessage={onSwitchModelForFailedMessage}
      onLoadFileChangesDiff={onLoadFileChangesDiff}
      onRevertFileChanges={onRevertFileChanges}
      onOpenFileChangesReview={onOpenFileChangesReview}
      fileChangesDiffPreviewDisabledSubtaskId={fileChangesDiffPreviewDisabledSubtaskId}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      onRequestUserInputSubmit={onRequestUserInputSubmit}
      onRequestUserInputIgnore={onRequestUserInputIgnore}
      onOpenAssistantPlan={onOpenAssistantPlan}
      onOpenSubagent={onOpenSubagent}
      hideRequestUserInputBlocks={hideRequestUserInputBlocks}
      hiddenRequestUserInputIds={hiddenRequestUserInputIds}
      onFork={onForkMessage && message.turnId ? () => onForkMessage(message) : undefined}
    />
  )
})
