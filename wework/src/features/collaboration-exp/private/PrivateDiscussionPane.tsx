import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  canStartWorkOnCollaborationIssue,
  type CollaborationIssue,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperiencePrivateConversation } from '../model'
import { useConclusionPublication } from './useConclusionPublication'
import { useExperienceDraftInput } from '../useExperienceDraftInput'

export interface PrivateDiscussionPaneProps {
  api: SharedWorkspaceApi
  project: CollaborationProject
  issue: CollaborationIssue
  conversation: ExperiencePrivateConversation
  active?: boolean
  embedded?: boolean
  sourceNodeId?: string
  historyScope?: 'source' | 'task'
  onPublished(): void | Promise<void>
  onClose?(): void
}

export function PrivateDiscussionPane(props: PrivateDiscussionPaneProps) {
  const { state } = useWorkbench()
  const connection = useCloudConnection()
  const accountKey = workbenchOwnershipKey(connection, state.user)
  const identity = JSON.stringify([
    accountKey,
    props.project.project_store,
    props.project.id,
    props.issue.id,
    props.conversation.ownerUserId,
    props.conversation.address.deviceId,
    props.conversation.address.taskId,
  ])
  return <PrivateDiscussionContent key={identity} {...props} accountKey={accountKey} />
}

function PrivateDiscussionContent(props: PrivateDiscussionPaneProps & { accountKey: string }) {
  const { project, issue, conversation, active = true, sourceNodeId, onClose } = props
  const { t } = useTranslation('collaborationExp')
  const { state, openRuntimeTask } = useWorkbench()
  const viewerId = project.current_user_id ?? state.user?.id
  const sourceScope =
    props.historyScope ?? (sourceNodeId || conversation.historySource ? 'source' : 'task')
  const scopeKey = JSON.stringify([
    'collaboration-exp-private',
    project.project_store,
    project.id,
    issue.id,
    conversation.ownerUserId,
    conversation.address.deviceId,
    conversation.address.taskId,
  ])
  const conclusionKey = `conclusion:${scopeKey}:${sourceNodeId ?? ''}`
  const discussionKey = `discussion:${scopeKey}`
  const discussionDraft = useExperienceDraftInput({
    accountKey: props.accountKey,
    scopeKey,
    inputKey: discussionKey,
  })
  const conclusionDraft = useExperienceDraftInput({
    accountKey: props.accountKey,
    scopeKey,
    inputKey: conclusionKey,
  })
  const source = sourceScope === 'source' ? conversation.historySource : undefined
  const accountMatches =
    project.project_store === 'local' ||
    project.current_user_id === undefined ||
    state.user?.id === project.current_user_id
  const owned =
    accountMatches &&
    viewerId !== undefined &&
    viewerId === conversation.ownerUserId &&
    issue.cloud_project_id === project.id &&
    canStartWorkOnCollaborationIssue(issue) &&
    conversation.bindingIds.length > 0 &&
    Boolean(conversation.address.deviceId && conversation.address.taskId)
  const sourceKnown =
    sourceScope === 'task' ||
    Boolean(
      source &&
      (source.turnId || source.userMessageIds.length) &&
      sourceNodeId &&
      conversation.sourceNodeIds.includes(sourceNodeId)
    )
  const identity = `${scopeKey}:${sourceScope}:${sourceNodeId ?? ''}`
  const [history, setHistory] = useState<{ identity: string; available: boolean } | null>(null)
  const historyAvailable =
    sourceScope === 'task' || (history?.identity === identity && history.available)
  const address = useMemo(() => ({ ...conversation.address }), [conversation.address])
  const draft = {
    value: conclusionDraft.value,
    revision: conclusionDraft.revision,
    getValue: conclusionDraft.getValue,
    onChange: conclusionDraft.setValue,
    beginSubmission: conclusionDraft.beginSubmission,
  }
  const publication = useConclusionPublication({
    ...props,
    scopeKey: conclusionKey,
    expectedUserId: conversation.ownerUserId,
    active: active && owned && sourceKnown && historyAvailable,
    draft,
  })
  return (
    <section
      data-testid="collaboration-exp-private-pane"
      className="flex h-full min-h-0 flex-col bg-background"
      aria-label={t('private.title')}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          {!props.embedded && (
            <h2 className="truncate text-heading-sm font-medium">{t('private.title')}</h2>
          )}
          <p className="text-xs text-text-muted">{t('private.visibility')}</p>
        </div>
        {onClose && (
          <button
            type="button"
            data-testid="collaboration-exp-private-close"
            className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover max-md:size-11"
            aria-label={t('private.close')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        )}
      </header>
      {!owned || !sourceKnown ? (
        <p
          data-testid="collaboration-exp-private-unavailable"
          role="status"
          className="p-4 text-sm text-text-muted"
        >
          {t('private.sourceUnavailable')}
        </p>
      ) : (
        <>
          {sourceScope === 'source' && (
            <p className="px-4 pt-3 text-xs text-text-muted">{t('private.sourceScope')}</p>
          )}
          <div className="min-h-0 flex-1">
            <TemporaryChatPanel
              key={identity}
              currentProject={null}
              source={address}
              initialAddress={address}
              controlledAddress={address}
              instanceId={scopeKey}
              testId="collaboration-exp-private-conversation"
              draft={{
                value: discussionDraft.value,
                onChange: discussionDraft.setValue,
                beginSubmission: discussionDraft.beginSubmission,
              }}
              sendEphemeral={false}
              nativeConversation
              coordinateUserInput
              active={active}
              historySource={source}
              historySourceUnavailableText={t('private.sourceUnavailable')}
              onHistorySourceAvailabilityChange={available =>
                setHistory(current =>
                  current?.identity === identity && current.available === available
                    ? current
                    : { identity, available }
                )
              }
              emptyStateText={t('private.empty')}
              placeholder={t('private.placeholder')}
              onOpenRuntimeTask={openRuntimeTask}
            />
          </div>
          {historyAvailable && (
            <form
              className="shrink-0 space-y-2 border-t border-border p-4"
              data-testid="collaboration-exp-conclusion-form"
              onSubmit={event => {
                event.preventDefault()
                void publication.publish()
              }}
            >
              <label
                className="block text-sm font-medium"
                htmlFor={`conclusion-${encodeURIComponent(conclusionKey)}`}
              >
                {t('private.conclusion')}
              </label>
              <textarea
                id={`conclusion-${encodeURIComponent(conclusionKey)}`}
                data-testid="collaboration-exp-conclusion-text"
                className="min-h-24 w-full resize-y rounded-md border border-border bg-background p-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                value={draft.value}
                onChange={event => draft.onChange(event.target.value)}
              />
              <p className="text-xs text-text-muted">{t('private.publishHint')}</p>
              {conclusionDraft.persistenceError || discussionDraft.persistenceError ? (
                <p role="alert" className="text-xs text-error">
                  {t('private.errors.draftStorage')}
                </p>
              ) : null}
              {publication.error && (
                <p role="alert" className="text-xs text-error">
                  {t(`private.errors.${publication.error}`)}
                </p>
              )}
              <button
                type="submit"
                data-testid="collaboration-exp-conclusion-publish"
                className="min-h-7 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50 max-md:min-h-11"
                disabled={
                  !active || !historyAvailable || !draft.value.trim() || publication.publishing
                }
              >
                {t(publication.publishing ? 'private.publishing' : 'private.publish')}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  )
}
