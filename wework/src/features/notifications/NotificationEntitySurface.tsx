import { useCallback, useMemo } from 'react'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { NotificationIssueEntity } from './NotificationIssueEntity'
import { NotificationEntityContext } from './NotificationEntityContext'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import type { RuntimeTaskAddress } from '@/types/api'
import { parseWeworkScheme, weworkIssueScheme, weworkTaskScheme } from './scheme'
import { openWeworkScheme } from './schemeEvents'
import { useTranslation } from '@/hooks/useTranslation'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'

/** Notification destinations reuse the owning entity's existing UI and actions. */
export function NotificationEntitySurface({
  url,
  address,
  active,
  interactionId,
  sourceMessageIds,
  onOriginalUrlChange,
  focusedRequest,
}: {
  url: string
  address?: RuntimeTaskAddress
  active: boolean
  interactionId?: string
  sourceMessageIds?: string[]
  onOriginalUrlChange?: (interactionId: string, url: string) => void
  focusedRequest?: RequestUserInputPayload | null
}) {
  const { state } = useWorkbench()
  const { t } = useTranslation('common')
  const destination = useMemo(() => parseWeworkScheme(url), [url])
  const onFocusedMessage = useCallback(
    (messageId: string) => {
      if (!interactionId || destination?.kind !== 'board' || !destination.itemId) return
      const original = weworkIssueScheme(
        destination.projectId,
        destination.itemId,
        destination.projectStore ?? 'backend'
      )
      onOriginalUrlChange?.(interactionId, `${original}/comments/${encodeURIComponent(messageId)}`)
    },
    [destination, interactionId, onOriginalUrlChange]
  )
  const openTask = (task: RuntimeTaskAddress) => {
    openWeworkScheme(weworkTaskScheme(task))
  }

  if (state.isBootstrapping) {
    return (
      <p role="status" className="p-5 text-sm text-text-secondary">
        {t('interactions.loading')}
      </p>
    )
  }

  if (destination?.kind === 'task' && address) {
    return (
      <TemporaryChatPanel
        key={url}
        currentProject={null}
        source={address}
        initialAddress={address}
        instanceId={`notification-entity:${url}`}
        testId="notification-task-entity"
        sendEphemeral={false}
        coordinateUserInput
        focusedRequest={focusedRequest}
        sourceMessageIds={sourceMessageIds}
        focusRequestKey={interactionId}
        expanded
        active={active}
        initialScrollPosition="latest"
        onOpenRuntimeTask={openTask}
      />
    )
  }
  if (destination?.kind === 'board' && destination.itemId && state.user) {
    return (
      <NotificationEntityContext.Provider
        value={
          interactionId
            ? {
                id: interactionId,
                projectId: destination.projectId,
                issueId: destination.itemId,
                store: destination.projectStore ?? 'backend',
                rootCommentId: destination.commentId,
                address,
                sourceMessageIds,
                onFocusedMessage,
              }
            : null
        }
      >
        <NotificationIssueEntity
          key={url}
          projectId={destination.projectId}
          issueId={destination.itemId}
          store={destination.projectStore ?? 'backend'}
          commentId={destination.commentId}
          url={url}
          address={address}
          active={active}
        />
      </NotificationEntityContext.Provider>
    )
  }
  return (
    <p role="status" className="p-5 text-sm text-text-secondary">
      {t('interactions.entity_unavailable')}
    </p>
  )
}
