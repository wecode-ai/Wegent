import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Circle, FileText, Lock, Sparkles } from 'lucide-react'
import {
  IssueActivityMarkdown,
  issueNeedsUser,
  pendingIssueHumanRequests,
} from '@wegent/collaboration'
import type { CollaborationAttachment, SharedWorkspaceApi } from '@wegent/collaboration'
import type { AssistantParticipation } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import type { ExperienceIssueData } from '../data/useExperienceIssue'
import type { ExperienceTimelineData } from '../data/useExperienceTimeline'
import type {
  ExperienceAttachmentReference,
  ExperiencePrivateConversation,
  ExperienceTimelineNode,
} from '../model/types'
import { TimelineFilters, type TimelineFilter } from './TimelineFilters'
import { TimelineNode } from './TimelineNode'
import { matchesExperienceViewer, projectViewer } from '../model/sourceIdentity'
import { isPublishedTimelineConclusion } from '../model/messageLayer'
import './TimelineExperience.css'

export interface TimelineAttachmentSelection {
  id: string
  name: string
  sourceNodeId: string | null
}

interface Props {
  api: SharedWorkspaceApi
  data: ExperienceIssueData
  stream: ExperienceTimelineData
  active: boolean
  revision: number
  selectedNodeId?: string | null
  focusRequest?: string | null
  anchorUnavailable?: boolean
  filter?: TimelineFilter
  onFilterChange?(value: TimelineFilter): void
  onDiscuss(node: ExperienceTimelineNode | null, conversation: ExperiencePrivateConversation): void
  onAttachment(attachment: TimelineAttachmentSelection): void
  onExecution(address: RuntimeTaskAddress): void
  onRetry(): void
}

/** Canonical shared messages and explicit persisted history share a read-only presentation. */
export function TaskTimeline(props: Props) {
  const { t } = useTranslation('collaborationExp')
  const { issue } = props.data
  const { timeline, conversations, loading, error } = props.stream
  const contentRef = useRef<HTMLDivElement>(null)
  const selectedNodeId = props.selectedNodeId
  const focusRequest = props.focusRequest
  const filterRequest = JSON.stringify([selectedNodeId, focusRequest])
  const hasSelectedNode = timeline.nodes.some(node => node.id === selectedNodeId)
  useEffect(() => {
    if (!selectedNodeId || !hasSelectedNode) return
    const node = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[data-testid]') ?? []
    ).find(
      element => element.dataset.testid === `collaboration-exp-timeline-node-${selectedNodeId}`
    )
    node?.scrollIntoView?.({ block: 'nearest' })
    if (focusRequest) node?.focus({ preventScroll: true })
  }, [selectedNodeId, hasSelectedNode, focusRequest])
  const [filterState, setFilter] = useState({
    request: filterRequest,
    value: 'all' as TimelineFilter,
  })
  const filter = props.filter ?? (filterState.request === filterRequest ? filterState.value : 'all')
  const [attachmentState, setAttachmentState] = useState<{
    items: CollaborationAttachment[]
    error: string | null
  }>({ items: [], error: null })
  const participationScopeKey = JSON.stringify([
    props.data.project.project_store,
    props.data.project.id,
    issue.id,
    props.data.participationViewer,
  ])
  const participationRequestKey = JSON.stringify([participationScopeKey, props.revision])
  const [participationRetry, setParticipationRetry] = useState(0)
  const participationReadRequest = useRef(0)
  const [participationState, setParticipationState] = useState<{
    key: string
    items: AssistantParticipation[]
    error: string | null
  }>({ key: participationScopeKey, items: [], error: null })
  useEffect(() => {
    if (!props.active) return
    let cancelled = false
    void props.api.attachments.list(issue.id).then(
      items => {
        if (!cancelled) setAttachmentState({ items, error: null })
      },
      cause => {
        if (!cancelled) setAttachmentState(previous => ({ ...previous, error: String(cause) }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [props.api, issue.id, props.active, props.revision])
  useEffect(() => {
    const list = props.api.issues?.listAssistantParticipations
    if (!props.active || !list) return
    let cancelled = false
    void list(issue.id).then(
      items => {
        if (!cancelled) setParticipationState({ key: participationScopeKey, items, error: null })
      },
      cause => {
        if (!cancelled)
          setParticipationState(current => ({
            key: participationScopeKey,
            items: current.key === participationScopeKey ? current.items : [],
            error: cause instanceof Error ? cause.message : String(cause),
          }))
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    issue.id,
    participationRequestKey,
    participationRetry,
    participationScopeKey,
    props.active,
    props.api,
  ])
  useEffect(
    () => () => {
      participationReadRequest.current += 1
    },
    [issue.id, props.active]
  )
  const participations =
    participationState.key === participationScopeKey ? participationState : null
  const openParticipation = async (participation: AssistantParticipation) => {
    const read = props.api.issues?.readAssistantParticipation
    if (participation.historyState !== 'unverified' || !read) return
    const request = ++participationReadRequest.current
    try {
      const workroom = await read(issue.id, participation.id)
      if (request !== participationReadRequest.current) return
      if (workroom.runtimeAddress) props.onExecution(workroom.runtimeAddress)
    } catch {
      // The source access state remains authoritative and unchanged on a failed read.
    }
  }
  const nodes = timeline.nodes.filter(
    node =>
      filter === 'all' ||
      (filter === 'attachments' ? node.attachments.length > 0 : isPublishedTimelineConclusion(node))
  )
  const attachmentSources = new Map(
    timeline.nodes.flatMap(node =>
      node.attachments.map(attachment => [attachment.id, attachment] as const)
    )
  )
  const openAttachment = (attachment: ExperienceAttachmentReference) =>
    props.onAttachment(attachment)
  const viewer = projectViewer(
    props.data.project,
    props.data.participationViewer ?? Number.NaN,
    props.data.participationViewer
  )
  const needsUser = issueNeedsUser(issue, viewer)
  const request = pendingIssueHumanRequests(issue).find(request =>
    matchesExperienceViewer(
      request.recipient_user_id ??
        request.responsible_user_id ??
        issue.assignee_user_id ??
        issue.created_by_user_id,
      viewer
    )
  )
  const assignee =
    issue.assignee_name ??
    issue.assignee_group_name ??
    issue.assignee_agent_name ??
    issue.assignee_team_name ??
    (issue.assignee_user_id == null ? null : t('timeline.unknownMember'))
  const security = issue.security_level ?? props.data.project.default_issue_security
  return (
    <div
      className="experience-task-timeline"
      data-testid="collaboration-exp-timeline"
      data-read-state={timeline.state}
      aria-busy={loading}
    >
      <div className="experience-matter-context">
        <span>
          {t(
            security === 'related'
              ? 'timeline.visibilityRelated'
              : security === 'open'
                ? 'timeline.visibilityOpen'
                : 'timeline.visibilityUnknown'
          )}
        </span>
        {assignee ? <span>{t('timeline.assignee', { name: assignee })}</span> : null}
      </div>
      {props.anchorUnavailable ? (
        <p
          role="status"
          className="px-4 py-2 text-sm text-text-muted"
          data-testid="collaboration-exp-comment-unavailable"
        >
          {t('timeline.commentUnavailable')}
        </p>
      ) : null}
      <div ref={contentRef} className="experience-matter-scroll">
        <div className="experience-matter-document">
          {filter === 'all' && issue.description ? (
            <details
              className="experience-matter-background"
              data-testid="collaboration-exp-background"
            >
              <summary>{t('timeline.background')}</summary>
              <IssueActivityMarkdown
                content={issue.description}
                onOpenAttachment={(id, name) =>
                  props.onAttachment({ id, name, sourceNodeId: null })
                }
              />
            </details>
          ) : null}
          <TimelineFilters
            value={filter}
            onChange={value => {
              if (props.filter === undefined) setFilter({ request: filterRequest, value })
              props.onFilterChange?.(value)
            }}
          />
          {loading ? (
            <p role="status" className="p-4 text-sm">
              {t('loading')}
            </p>
          ) : null}
          {error || !props.api.activity ? (
            <div role="alert" className="p-4 text-sm">
              <p>{t('timeline.unavailable')}</p>
              {error ? <p className="break-words text-text-secondary">{error}</p> : null}
              <Button
                variant="ghost"
                data-testid="collaboration-exp-timeline-retry"
                onClick={props.onRetry}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className="experience-matter-events">
            {nodes.map(node => (
              <TimelineNode
                key={node.id}
                node={node}
                taskTitle={issue.title}
                selected={props.selectedNodeId === node.id}
                onDiscuss={props.onDiscuss}
                onAttachment={openAttachment}
                onExecution={props.onExecution}
              />
            ))}
          </div>
          {props.active && (participations?.items.length || participations?.error) ? (
            <section
              className="experience-matter-participations"
              data-testid="collaboration-exp-assistant-participations"
            >
              <h2>{t('timeline.assistantSources')}</h2>
              {participations.items.map(participation => (
                <div
                  key={participation.id}
                  data-testid={`collaboration-exp-assistant-participation-${participation.id}`}
                >
                  <span>
                    {participation.ownerDisplayName || t('timeline.unknownMember')} ·{' '}
                    {participation.roleId}
                  </span>
                  <small>{t(`timeline.participation.${participation.historyState}`)}</small>
                  {participation.historyState === 'unverified' &&
                  props.api.issues?.readAssistantParticipation ? (
                    <Button
                      variant="ghost"
                      data-testid={`collaboration-exp-open-assistant-participation-${participation.id}`}
                      onClick={() => void openParticipation(participation)}
                    >
                      <ArrowRight size={13} aria-hidden="true" />
                      {t('timeline.openAssistantSource')}
                    </Button>
                  ) : null}
                </div>
              ))}
              {participations.error ? (
                <p role="alert">
                  {participations.error}{' '}
                  <Button
                    variant="ghost"
                    data-testid="collaboration-exp-assistant-participations-retry"
                    onClick={() => setParticipationRetry(current => current + 1)}
                  >
                    {t('retry')}
                  </Button>
                </p>
              ) : null}
            </section>
          ) : null}
          {timeline.state === 'ready' && !nodes.length ? (
            <p className="px-4 py-6 text-sm text-text-muted">{t('timeline.empty')}</p>
          ) : null}
          {filter !== 'conclusions' && attachmentState.items.length ? (
            <section
              className="experience-matter-attachment-index"
              data-testid="collaboration-exp-attachment-index"
            >
              <h2>{t('timeline.attachments')}</h2>
              <div className="experience-timeline-attachments">
                {attachmentState.items.map(attachment => {
                  const source = attachmentSources.get(attachment.id)
                  return (
                    <Button
                      key={attachment.id}
                      variant="ghost"
                      data-testid={`collaboration-exp-attachment-${attachment.id}`}
                      onClick={() =>
                        props.onAttachment(
                          source ?? {
                            id: attachment.id,
                            name: attachment.display_name,
                            sourceNodeId: null,
                          }
                        )
                      }
                    >
                      <FileText size={15} aria-hidden="true" />
                      <span>{attachment.display_name}</span>
                      {!source ? <small>{t('timeline.unknownSource')}</small> : null}
                    </Button>
                  )
                })}
              </div>
            </section>
          ) : null}
          {attachmentState.error ? (
            <div role="alert" className="p-4 text-sm">
              <p>{t('timeline.attachmentsFailed')}</p>
              <Button
                variant="ghost"
                data-testid="collaboration-exp-attachments-retry"
                onClick={props.onRetry}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          {needsUser || conversations.items.length ? (
            <section
              className="experience-matter-turn"
              data-testid="collaboration-exp-current-turn"
            >
              {needsUser ? (
                <>
                  <div className="experience-matter-turn-label">
                    <Circle size={14} aria-hidden="true" />
                    {t('timeline.yourTurn')}
                  </div>
                  <h2>{request?.question ?? issue.title}</h2>
                </>
              ) : null}
              <div className="experience-matter-turn-actions">
                {conversations.items.map(conversation => (
                  <Button
                    key={conversation.key}
                    className="experience-matter-process"
                    data-testid={`collaboration-exp-task-discussion-${conversation.address.taskId}`}
                    onClick={() => props.onDiscuss(null, conversation)}
                  >
                    <Sparkles size={16} aria-hidden="true" />
                    <span>
                      {conversations.items.length === 1
                        ? t('timeline.processWithAssistant')
                        : (conversation.title ?? t('timeline.processWithAssistant'))}
                    </span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Button>
                ))}
              </div>
              <small>
                <Lock size={12} aria-hidden="true" />
                {t(
                  conversations.items.length ? 'timeline.privateHint' : 'timeline.discussionUnknown'
                )}
              </small>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
