import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { RuntimeTaskAddress } from '@/types/api'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useState } from 'react'
import type { ExperiencePrivateConversation } from '../model'
import { useExperienceDraftInput } from '../useExperienceDraftInput'
import { acceptedAssistantConversation } from './acceptedAssistantConversations'
import { selectAssistantConversation } from './assistantConversationIdentity'
import { useAssistantSources } from './useAssistantSources'

export interface AssistantConversationPaneProps {
  active: boolean
  address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>
}

export function AssistantConversationPane(props: AssistantConversationPaneProps) {
  const { state } = useWorkbench()
  const connection = useOptionalCloudConnection()
  const accountKey = workbenchOwnershipKey(connection, state.user)
  return (
    <AssistantConversationContent
      key={JSON.stringify([accountKey, props.address.deviceId, props.address.taskId])}
      {...props}
      accountKey={accountKey}
    />
  )
}

function AssistantConversationContent({
  active,
  address,
  accountKey,
}: AssistantConversationPaneProps & { accountKey: string }) {
  const { t } = useTranslation('collaborationExp')
  const { state, refreshWorkLists } = useWorkbench()
  const source = useAssistantSources(active, false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const accepted = acceptedAssistantConversation(accountKey, address)
  const ownerId = source.ownerId ?? accepted?.ownerUserId
  const conversation =
    ownerId !== undefined
      ? selectAssistantConversation(
          {
            ownerUserId: ownerId,
            inboxDeviceId: source.deviceId,
            inbox: source.inbox.items,
            runtimeWork: state.runtimeWork,
            accepted,
          },
          address
        )
      : null
  if (!conversation)
    return (
      <div
        role={source.error ? 'alert' : 'status'}
        className="p-4 text-sm text-text-secondary"
        data-testid="collaboration-exp-assistant-conversation-unavailable"
      >
        {source.loading || state.runtimeWork === null
          ? t('assistant.loading')
          : t('assistant.conversationUnavailable')}
        {source.error ? <p className="mt-2">{getStandInErrorMessage(source.error)}</p> : null}
        {refreshError && (
          <p role="alert" className="mt-2">
            {refreshError}
          </p>
        )}
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="collaboration-exp-assistant-conversation-retry"
          onClick={() => {
            setRefreshError(null)
            source.refresh()
            source.inbox.refresh()
            void refreshWorkLists().catch(cause => setRefreshError(getStandInErrorMessage(cause)))
          }}
          className="mt-2 min-h-11 underline md:min-h-8"
        >
          {t('assistant.retry')}
        </ControlButton>
      </div>
    )
  return (
    <VerifiedAssistantConversation
      active={active}
      accountKey={accountKey}
      conversation={conversation}
    />
  )
}

function VerifiedAssistantConversation({
  active,
  accountKey,
  conversation,
}: {
  active: boolean
  accountKey: string
  conversation: ExperiencePrivateConversation
}) {
  const { t } = useTranslation('collaborationExp')
  const scopeKey = JSON.stringify([
    'collaboration-exp-assistant-conversation',
    conversation.ownerUserId,
    conversation.address.deviceId,
    conversation.address.taskId,
  ])
  const draft = useExperienceDraftInput({ accountKey, scopeKey, inputKey: 'discussion' })
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="collaboration-exp-assistant-conversation-pane"
    >
      {Boolean(draft.persistenceError) && (
        <p role="alert" className="px-4 py-2 text-sm text-error">
          {t('assistant.draftPersistenceFailed')}
        </p>
      )}
      <TemporaryChatPanel
        currentProject={null}
        source={conversation.address}
        initialAddress={conversation.address}
        controlledAddress={conversation.address}
        instanceId={scopeKey}
        testId="collaboration-exp-assistant-conversation"
        draft={{
          value: draft.value,
          onChange: draft.setValue,
          beginSubmission: draft.beginSubmission,
        }}
        sendEphemeral={false}
        nativeConversation
        showActivityDots
        active={active}
        emptyStateText={t('assistant.conversationEmpty')}
        placeholder={t('assistant.placeholder')}
      />
    </div>
  )
}
