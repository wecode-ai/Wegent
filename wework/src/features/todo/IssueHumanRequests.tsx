import { DesktopConversationTranslation } from '@/components/chat/DesktopConversationTranslation'
import { replyToInteractionProject } from '@/features/notifications/interactionProjectReply'
import { issueHumanInteraction } from '@/features/notifications/issueHumanInteractions'
import { IssueWaitingTime } from '@/features/notifications/IssueWaitingTime'
import { useRuntimeInteractions } from '@/features/notifications/RuntimeInteractionsContext'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { requestUserInputResponseText } from '@wegent/chat-core/runtime-user-input'
import type { CollaborationMember, IssueHumanRequest } from '@wegent/collaboration'
import { issueHumanAssignees, WaitingForPersonIcon } from '@wegent/collaboration'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { RequestUserInputCard } from '@wegent/collaboration/conversation'
import { useMemo, useState, useSyncExternalStore } from 'react'

export function IssueHumanRequests({
  services,
  projectId,
  issueId,
  store,
  userId,
  members,
}: {
  services: WorkbenchServices
  projectId: string
  issueId: string
  store: 'local' | 'backend'
  userId?: string | number
  members: CollaborationMember[]
}) {
  const { t } = useTranslation('common')
  const interactions = useRuntimeInteractions()
  const localAuthor = services.localParticipationIdentity?.currentUser ?? {
    id: 0,
    user_name: 'local',
  }
  const handlingUserId = store === 'local' ? localAuthor.id : userId
  const api =
    store === 'local' ? services.localIssueHumanRequestsApi : services.issueHumanRequestsApi
  const [busyState, setBusyState] = useState<{ owner: object; value: string | undefined } | null>(
    null
  )
  const [failure, setFailure] = useState<{
    owner: object
    receipt: { requests: IssueHumanRequest[] } | undefined
    message: string
  } | null>(null)
  const resource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify([store, projectId, issueId, handlingUserId]),
        async signal => {
          await Promise.resolve()
          signal.throwIfAborted()
          if (!api) throw new Error('A human request API is required')
          return { requests: (await api.list(projectId, issueId)).items }
        },
        { refreshIntervalMs: 5000 }
      ),
    [api, projectId, issueId, store, handlingUserId]
  )
  const snapshot = useSyncExternalStore(
    api ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const requests = snapshot.data?.requests ?? []
  const busy = busyState?.owner === resource ? busyState.value : undefined
  const error =
    snapshot.status === 'error'
      ? snapshot.error instanceof Error
        ? snapshot.error.message
        : String(snapshot.error)
      : failure?.owner === resource && failure.receipt === snapshot.data
        ? failure.message
        : undefined
  const setBusy = (value: string | undefined) => {
    if (resource.hasSubscribers()) setBusyState({ owner: resource, value })
  }
  const setError = (message: string) => {
    if (resource.hasSubscribers())
      setFailure({ owner: resource, receipt: resource.getSnapshot().data, message })
  }
  const refresh = resource.reload
  const candidates =
    store === 'local'
      ? [
          { user_id: localAuthor.id, user_name: localAuthor.user_name },
          ...members.filter(
            member =>
              Number(member.user_id) !== Number(localAuthor.id) && Number(member.user_id) !== 0
          ),
        ]
      : members
  if (!api || (!requests.some(item => ['pending', 'answering'].includes(item.status)) && !error))
    return null
  return (
    <section
      className="task-detail-human-requests space-y-3 py-3"
      data-testid="issue-human-requests"
      aria-label={t('issueParticipation.waiting')}
    >
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {requests
        .filter(item => ['pending', 'answering'].includes(item.status))
        .map(request => {
          const interaction = issueHumanInteraction(request, store)
          const person = issueHumanAssignees({ human_requests: [request] })[0]
          const personName =
            person?.name ||
            candidates.find(member => Number(member.user_id) === person?.id)?.user_name ||
            ''
          const questionIds =
            interaction.payload.questions?.map(question => question.id ?? '') ?? []
          const draft = interactions?.drafts[interaction.id] ?? ''
          let draftAnswers: Record<string, string> = { [questionIds[0] ?? request.id]: draft }
          if (questionIds.length > 1) {
            try {
              const parsed: unknown = JSON.parse(draft)
              draftAnswers =
                parsed && typeof parsed === 'object'
                  ? Object.fromEntries(
                      Object.entries(parsed).filter(
                        ([key, value]) => questionIds.includes(key) && typeof value === 'string'
                      )
                    )
                  : {}
            } catch {
              draftAnswers = {}
            }
          }
          return (
            <div
              key={request.id}
              className="task-detail-human-request space-y-2"
              data-testid={`issue-human-request-${request.id}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
                <span
                  role="img"
                  aria-label={t('issueParticipation.waiting_for', { name: personName })}
                  className="inline-flex items-center gap-1"
                >
                  <WaitingForPersonIcon />
                  {personName}
                </span>
                <IssueWaitingTime
                  since={
                    request.waiting_since ??
                    (request.recipient_user_id == null ? request.created_at : null)
                  }
                />
                <SelectRoot
                  value={normalizeSelectValue(request.recipient_user_id ?? '')}
                  disabled={
                    Boolean(error) ||
                    busy === request.id ||
                    request.status !== 'pending' ||
                    request.can_assign === false
                  }
                  onValueChange={selectedValue => {
                    if (selectedValue === null) return
                    const member = candidates.find(
                      member => String(member.user_id) === selectedValue
                    )
                    if (!member) return
                    setBusy(request.id)
                    void api
                      .assign(projectId, issueId, request, {
                        id: Number(member.user_id),
                        name: member.user_name,
                      })
                      .then(refresh)
                      .catch(cause => setError(String(cause)))
                      .finally(() => setBusy(undefined))
                  }}
                >
                  <SelectTrigger
                    density="compact"
                    aria-label={t('issueParticipation.assign')}
                    data-testid={`issue-human-request-assignee-${request.id}`}
                  />
                  <SelectContent>
                    <SelectItem value="">{t('issueParticipation.assign')}</SelectItem>
                    {candidates.map(member => (
                      <SelectItem key={member.user_id} value={String(member.user_id)}>
                        {member.user_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
                {request.status === 'answering' && (
                  <span>{t('issueParticipation.delivering')}</span>
                )}
                {request.blocks_progress && <span>{t('issueParticipation.blocking')}</span>}
                {request.delivery_error && (
                  <span role="status">
                    {t(`issueParticipation.delivery_${request.delivery_error}`)}
                  </span>
                )}
              </div>
              <DesktopConversationTranslation>
                <RequestUserInputCard
                  payload={interaction.payload}
                  draftAnswers={interactions ? draftAnswers : undefined}
                  onDraftAnswersChange={answers =>
                    interactions?.setDraft(
                      interaction.id,
                      questionIds.length > 1
                        ? JSON.stringify(answers)
                        : (answers[questionIds[0] ?? request.id] ?? '')
                    )
                  }
                  disabled={
                    Boolean(error) ||
                    busy === request.id ||
                    request.status !== 'pending' ||
                    request.can_reply === false ||
                    String(request.recipient_user_id) !== String(handlingUserId)
                  }
                  onSubmit={async response => {
                    setBusy(request.id)
                    try {
                      await replyToInteractionProject(
                        interaction,
                        requestUserInputResponseText(response),
                        crypto.randomUUID(),
                        services,
                        t('interactions.failed')
                      )
                      await refresh()
                      interactions?.setDraft(interaction.id, '')
                      return true
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause))
                      return false
                    } finally {
                      setBusy(undefined)
                    }
                  }}
                />
              </DesktopConversationTranslation>
            </div>
          )
        })}
    </section>
  )
}
