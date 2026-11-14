import {
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  FileText,
  LoaderCircle,
  Lock,
  Play,
} from 'lucide-react'
import { IssueActivityMarkdown } from '@wegent/collaboration'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import type {
  ExperienceAttachmentReference,
  ExperiencePrivateConversation,
  ExperienceTimelineNode,
} from '../model/types'

export interface TimelineNodeProps {
  node: ExperienceTimelineNode
  taskTitle: string
  selected: boolean
  onDiscuss(node: ExperienceTimelineNode, conversation: ExperiencePrivateConversation): void
  onAttachment(attachment: ExperienceAttachmentReference): void
  onExecution(address: RuntimeTaskAddress): void
}

export function TimelineNode({
  node,
  taskTitle,
  selected,
  onDiscuss,
  onAttachment,
  onExecution,
}: TimelineNodeProps) {
  const { t, i18n } = useTranslation('collaborationExp')
  const time = node.at
    ? new Intl.DateTimeFormat(i18n.language, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(node.at))
    : t('timeline.unknownTime')
  const userName = node.author
    ? (node.author.name ?? t('tasks.unnamedUser', { id: node.author.id }))
    : t('timeline.system')
  const execution = node.kind === 'execution'
  const completed = execution && node.status === 'completed'
  const running = execution && node.status === 'streaming'
  const failed = execution && node.status === 'failed'
  const Icon = completed ? Check : failed ? CircleAlert : running ? LoaderCircle : Circle
  const hasDiscussion = node.conversation.items.length > 0
  const status = completed
    ? t('assistant.status.completed')
    : failed
      ? t('assistant.status.failed')
      : running
        ? t('assistant.status.running')
        : node.status
  return (
    <article
      tabIndex={-1}
      className="experience-timeline-node"
      data-state={completed ? 'completed' : failed ? 'failed' : running ? 'running' : 'recorded'}
      data-linked={selected || undefined}
      data-self={hasDiscussion || undefined}
      data-testid={`collaboration-exp-timeline-node-${node.id}`}
    >
      <span className="experience-timeline-rail" aria-hidden="true">
        <Icon />
      </span>
      <header>
        <strong>{userName}</strong>
        <span className="experience-timeline-node-state">
          {execution ? status : t(hasDiscussion ? 'timeline.sent' : 'timeline.recorded')}
        </span>
        <time dateTime={node.at ?? undefined}>{time}</time>
      </header>
      {node.kind === 'status' && node.transition ? (
        <p className="experience-timeline-summary">
          {t('timeline.statusChanged', node.transition)}
        </p>
      ) : null}
      {node.kind === 'handoff' && node.handoff ? (
        <p className="experience-timeline-summary">
          {t('timeline.handoff', {
            action: t(
              `timeline.handoffActions.${['assign', 'reassign', 'unassign'].includes(node.handoff.action) ? node.handoff.action : 'unknown'}`
            ),
            target: node.handoff.targetName ?? node.handoff.targetId ?? t('timeline.unknownSource'),
          })}
        </p>
      ) : null}
      {node.body ? (
        <div className="experience-timeline-summary">
          <IssueActivityMarkdown
            content={node.body}
            onOpenAttachment={(id, name) => onAttachment({ id, name, sourceNodeId: node.id })}
          />
        </div>
      ) : null}
      {node.kind === 'execution' ? (
        <div className="experience-timeline-execution">
          {node.executionAddress ? (
            <Button
              variant="ghost"
              data-testid={`collaboration-exp-execution-${node.id}`}
              onClick={() => onExecution(node.executionAddress!)}
              className="experience-timeline-execution-link"
              aria-label={t('timeline.openExecution')}
            >
              <Play size={16} aria-hidden="true" />
              <span>{taskTitle}</span>
              <small>{status}</small>
              <ArrowRight size={13} aria-hidden="true" />
            </Button>
          ) : (
            <>
              <span>{taskTitle}</span>
              <span>{t('timeline.unknownSource')}</span>
            </>
          )}
        </div>
      ) : null}
      {node.attachments.length ? (
        <div className="experience-timeline-attachments">
          {node.attachments.map(attachment => (
            <Button
              key={attachment.id}
              variant="ghost"
              data-testid={`collaboration-exp-node-attachment-${node.id}-${attachment.id}`}
              onClick={() => onAttachment(attachment)}
            >
              <FileText size={15} aria-hidden="true" />
              <span>{attachment.name}</span>
            </Button>
          ))}
        </div>
      ) : null}
      <div className="experience-timeline-discussions">
        {node.conversation.items.map(conversation => (
          <Button
            key={conversation.key}
            variant="ghost"
            className="experience-timeline-private-link"
            data-testid={`collaboration-exp-node-discussion-${node.id}-${conversation.address.taskId}`}
            onClick={() => onDiscuss(node, conversation)}
          >
            <Lock size={12} aria-hidden="true" />
            <span>{t('timeline.reviewDiscussion')}</span>
            <ArrowRight size={13} aria-hidden="true" />
          </Button>
        ))}
        {node.conversation.state === 'unknown' &&
        node.kind !== 'status' &&
        node.kind !== 'handoff' ? (
          <span className="experience-timeline-source-note">
            <Lock size={12} aria-hidden="true" />
            {t('timeline.discussionUnknown')}
          </span>
        ) : null}
        {node.conversation.state === 'hidden' && node.kind === 'comment' ? (
          <span className="experience-timeline-source-note">
            <Lock size={12} aria-hidden="true" />
            {t('timeline.discussionOther')}
          </span>
        ) : null}
      </div>
    </article>
  )
}
