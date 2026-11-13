import { useEffect, useRef, useState } from 'react'
import { File } from 'lucide-react'
import { IssueActivityMarkdown } from '@wegent/collaboration'
import type { CollaborationAttachment, SharedWorkspaceApi } from '@wegent/collaboration'
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
  const filter = filterState.request === filterRequest ? filterState.value : 'all'
  const [attachmentState, setAttachmentState] = useState<{
    items: CollaborationAttachment[]
    error: string | null
  }>({ items: [], error: null })
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
  const nodes = timeline.nodes.filter(
    node =>
      filter === 'all' ||
      (filter === 'attachments' ? node.attachments.length > 0 : node.kind === 'comment')
  )
  const attachmentSources = new Map(
    timeline.nodes.flatMap(node =>
      node.attachments.map(attachment => [attachment.id, attachment] as const)
    )
  )
  const openAttachment = (attachment: ExperienceAttachmentReference) =>
    props.onAttachment(attachment)
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="collaboration-exp-timeline">
      <TimelineFilters
        value={filter}
        onChange={value => setFilter({ request: filterRequest, value })}
      />
      {props.anchorUnavailable ? (
        <p
          role="status"
          className="px-4 py-2 text-sm text-text-muted"
          data-testid="collaboration-exp-comment-unavailable"
        >
          {t('timeline.commentUnavailable')}
        </p>
      ) : null}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {filter === 'all' && issue.description ? (
          <section className="px-4 py-4">
            <h2 className="mb-2 text-sm font-medium">{t('timeline.background')}</h2>
            <IssueActivityMarkdown
              content={issue.description}
              onOpenAttachment={(id, name) => props.onAttachment({ id, name, sourceNodeId: null })}
            />
          </section>
        ) : null}
        {conversations.items.length ? (
          <div className="flex flex-wrap gap-1 px-4 pb-2">
            {conversations.items.map(conversation => (
              <Button
                key={conversation.key}
                variant="ghost"
                className="min-h-11 max-w-full md:min-h-8"
                data-testid={`collaboration-exp-task-discussion-${conversation.address.taskId}`}
                onClick={() => props.onDiscuss(null, conversation)}
              >
                {conversation.title ?? t('timeline.discuss')}
              </Button>
            ))}
          </div>
        ) : null}
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
        {timeline.state === 'ready' && !nodes.length ? (
          <p className="px-4 py-6 text-sm text-text-muted">{t('timeline.empty')}</p>
        ) : null}
        {filter !== 'conclusions' && attachmentState.items.length ? (
          <section className="px-4 py-4" data-testid="collaboration-exp-attachment-index">
            <h2 className="mb-2 text-sm font-medium">{t('timeline.attachments')}</h2>
            {attachmentState.items.map(attachment => {
              const source = attachmentSources.get(attachment.id)
              return (
                <Button
                  key={attachment.id}
                  variant="ghost"
                  className="min-h-11 w-full min-w-0 justify-start md:min-h-8"
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
                  <File size={16} className="shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{attachment.display_name}</span>
                  {!source ? (
                    <span className="ml-auto shrink-0 text-xs text-text-muted">
                      {t('timeline.unknownSource')}
                    </span>
                  ) : null}
                </Button>
              )
            })}
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
      </div>
    </div>
  )
}
