import { useCallback, useEffect, useRef, useState } from 'react'
import { RequestUserInputCard } from '@wegent/collaboration/conversation'
import {
  issueHumanAssignees,
  WaitingForPersonIcon,
  type IssueHumanRequest,
  type CollaborationMember,
} from '@wegent/collaboration'
import { requestUserInputResponseText } from '@wegent/chat-core/runtime-user-input'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { issueHumanInteraction } from '@/features/notifications/issueHumanInteractions'
import { replyToInteractionProject } from '@/features/notifications/interactionProjectReply'
import { useRuntimeInteractions } from '@/features/notifications/RuntimeInteractionsContext'
import { IssueWaitingTime } from '@/features/notifications/IssueWaitingTime'
import { DesktopConversationTranslation } from '@/components/chat/DesktopConversationTranslation'

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
  const [requests, setRequests] = useState<IssueHumanRequest[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const sequence = useRef(0)
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
  const refresh = useCallback(async () => {
    if (!api) return
    const current = ++sequence.current
    try {
      const response = await api.list(projectId, issueId)
      if (sequence.current !== current) return
      setRequests(response.items)
      setError(undefined)
    } catch (cause) {
      if (sequence.current !== current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [api, projectId, issueId])
  const invalidateRequests = useCallback(() => {
    sequence.current++
  }, [])
  useEffect(() => {
    void Promise.resolve().then(refresh)
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      invalidateRequests()
      window.clearInterval(timer)
    }
  }, [refresh, invalidateRequests])
  if (!api || (!requests.some(item => ['pending', 'answering'].includes(item.status)) && !error))
    return null
  return (
    <section
      className="space-y-3 py-3"
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
              className="space-y-2"
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
                <select
                  className="min-h-11 rounded-md border border-border bg-background px-2 py-1 text-sm text-text-primary md:min-h-8"
                  aria-label={t('issueParticipation.assign')}
                  data-testid={`issue-human-request-assignee-${request.id}`}
                  value={request.recipient_user_id ?? ''}
                  disabled={
                    Boolean(error) ||
                    busy === request.id ||
                    request.status !== 'pending' ||
                    request.can_assign === false
                  }
                  onChange={event => {
                    const member = candidates.find(
                      member => String(member.user_id) === event.target.value
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
                  <option value="">{t('issueParticipation.assign')}</option>
                  {candidates.map(member => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.user_name}
                    </option>
                  ))}
                </select>
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
