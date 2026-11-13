import { useMemo, useState } from 'react'
import { ChevronRight, Lock, X } from 'lucide-react'
import {
  canStartWorkOnCollaborationIssue,
  type CollaborationIssue,
  type CollaborationProject,
  type IssueParticipationViewer,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { workbenchOwnershipKey } from '@/features/workbench/workbenchOwnership'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useTranslation } from '@/hooks/useTranslation'
import type { ExperiencePrivateConversation } from '../model'
import { matchesExperienceViewer, projectViewer } from '../model/sourceIdentity'
import { useConclusionPublication } from './useConclusionPublication'
import { useExperienceDraftInput } from '../useExperienceDraftInput'
import './PrivateExperience.css'

export interface PrivateDiscussionPaneProps {
  api: SharedWorkspaceApi
  project: CollaborationProject
  issue: CollaborationIssue
  conversation: ExperiencePrivateConversation
  participationViewer?: IssueParticipationViewer
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
  const actorId = project.current_user_id ?? state.user?.id
  const reader = projectViewer(project, Number(state.user?.id), props.participationViewer)
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
    project.current_user_id === undefined || state.user?.id === project.current_user_id
  const owned =
    accountMatches &&
    actorId !== undefined &&
    matchesExperienceViewer(conversation.ownerUserId, reader) &&
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
    expectedUserId: Number(actorId),
    active: active && owned && sourceKnown && historyAvailable,
    draft,
  })
  return (
    <section
      data-testid="collaboration-exp-private-pane"
      className="experience-private-discussion"
      aria-label={t('private.title')}
    >
      {!props.embedded && (
        <header className="experience-private-standalone-heading">
          <h2>{t('private.title')}</h2>
          {onClose && (
            <button
              type="button"
              data-testid="collaboration-exp-private-close"
              aria-label={t('private.close')}
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </header>
      )}
      <div className="experience-private-context">
        <span title={issue.title}>{issue.title}</span>
        <small>
          {props.embedded && onClose ? (
            <button
              type="button"
              className="experience-private-context-back"
              data-testid="collaboration-exp-private-close"
              onClick={onClose}
            >
              {t('private.taskProgress')}
            </button>
          ) : (
            <span>{t('private.taskProgress')}</span>
          )}
          <ChevronRight size={11} aria-hidden="true" />
          <Lock size={10} aria-hidden="true" />
          {t('private.title')}
        </small>
      </div>
      {!owned || !sourceKnown ? (
        <p
          data-testid="collaboration-exp-private-unavailable"
          role="status"
          className="experience-private-unavailable"
        >
          {t('private.sourceUnavailable')}
        </p>
      ) : (
        <>
          {sourceScope === 'source' && (
            <div className="experience-private-history-notice">
              <Lock size={13} aria-hidden="true" />
              <span>{t('private.sourceScope')}</span>
            </div>
          )}
          <div className="experience-private-native">
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
              className="experience-private-conclusion"
              data-testid="collaboration-exp-conclusion-form"
              onSubmit={event => {
                event.preventDefault()
                void publication.publish()
              }}
            >
              <label htmlFor={`conclusion-${encodeURIComponent(conclusionKey)}`}>
                {t('private.conclusion')}
              </label>
              <textarea
                id={`conclusion-${encodeURIComponent(conclusionKey)}`}
                data-testid="collaboration-exp-conclusion-text"
                value={draft.value}
                onChange={event => draft.onChange(event.target.value)}
              />
              <p className="experience-private-publish-hint">
                <Lock size={12} aria-hidden="true" />
                {t('private.publishHint')}
              </p>
              {conclusionDraft.persistenceError || discussionDraft.persistenceError ? (
                <p role="alert">{t('private.errors.draftStorage')}</p>
              ) : null}
              {publication.error && <p role="alert">{t(`private.errors.${publication.error}`)}</p>}
              <div className="experience-private-conclusion-actions">
                <span className="experience-private-visibility">
                  <Lock size={11} aria-hidden="true" />
                  {t('private.visibility')}
                </span>
                <button
                  type="submit"
                  data-testid="collaboration-exp-conclusion-publish"
                  disabled={
                    !active || !historyAvailable || !draft.value.trim() || publication.publishing
                  }
                >
                  {t(publication.publishing ? 'private.publishing' : 'private.publish')}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  )
}
