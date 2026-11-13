import { File, MessageSquare, Play } from 'lucide-react'
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
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(node.at)
      )
    : t('timeline.unknownTime')
  const userName = node.author
    ? (node.author.name ?? t('tasks.unnamedUser', { id: node.author.id }))
    : t('timeline.system')
  return (
    <article
      tabIndex={-1}
      className={`min-w-0 px-4 py-4 ${selected ? 'bg-muted' : ''}`}
      data-testid={`collaboration-exp-timeline-node-${node.id}`}
    >
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">{userName}</span>
        <span className="text-text-muted">{time}</span>
      </div>
      {node.kind === 'status' && node.transition ? (
        <p className="text-sm text-text-secondary">
          {t('timeline.statusChanged', node.transition)}
        </p>
      ) : null}
      {node.kind === 'handoff' && node.handoff ? (
        <p className="text-sm text-text-secondary">
          {t('timeline.handoff', {
            action: t(
              `timeline.handoffActions.${['assign', 'reassign', 'unassign'].includes(node.handoff.action) ? node.handoff.action : 'unknown'}`
            ),
            target: node.handoff.targetName ?? node.handoff.targetId ?? t('timeline.unknownSource'),
          })}
        </p>
      ) : null}
      {node.body ? (
        <IssueActivityMarkdown
          content={node.body}
          onOpenAttachment={(id, name) => onAttachment({ id, name, sourceNodeId: node.id })}
        />
      ) : null}
      {node.kind === 'execution' ? (
        <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
          <span className="min-w-0 flex-1 truncate">{taskTitle}</span>
          <span>{node.status}</span>
          {node.executionAddress ? (
            <Button
              variant="ghost"
              data-testid={`collaboration-exp-execution-${node.id}`}
              onClick={() => onExecution(node.executionAddress!)}
              className="min-h-11 shrink-0 md:min-h-8"
            >
              <Play size={16} aria-hidden="true" />
              {t('timeline.openExecution')}
            </Button>
          ) : (
            <span>{t('timeline.unknownSource')}</span>
          )}
        </div>
      ) : null}
      {node.attachments.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {node.attachments.map(attachment => (
            <Button
              key={attachment.id}
              variant="secondary"
              className="min-h-11 max-w-full md:min-h-8"
              data-testid={`collaboration-exp-node-attachment-${node.id}-${attachment.id}`}
              onClick={() => onAttachment(attachment)}
            >
              <File size={16} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{attachment.name}</span>
            </Button>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {node.conversation.items.map(conversation => (
          <Button
            key={conversation.key}
            variant="ghost"
            className="min-h-11 max-w-full md:min-h-8"
            data-testid={`collaboration-exp-node-discussion-${node.id}-${conversation.address.taskId}`}
            onClick={() => onDiscuss(node, conversation)}
          >
            <MessageSquare size={16} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{conversation.title ?? t('timeline.discuss')}</span>
          </Button>
        ))}
        {node.conversation.state === 'unknown' &&
        node.kind !== 'status' &&
        node.kind !== 'handoff' ? (
          <span className="py-2 text-xs text-text-muted">{t('timeline.discussionUnknown')}</span>
        ) : null}
      </div>
    </article>
  )
}
