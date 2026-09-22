import { AlertTriangle } from 'lucide-react'
import {
  CollaborationIssueCardContent,
  type CollaborationIssueCardProps,
} from './CollaborationIssueCard'
import { IssueCardGoalSummary } from './IssueCardTaskSummary'
import { IssueCardWorkflowStage } from './IssueCardWorkflowStage'
import { workflowNodeStatusLabel } from '../issue-detail/workflowStagePresentation'
import type { SharedWorkflowNode } from '../issue-detail/workflowTypes'
import type { CollaborationTranslate } from '../i18n'
import { Tooltip } from '../issue-detail/Tooltip'

export function IssueExecutionConfigurationBadge({
  itemId,
  translate: t,
}: {
  itemId: string
  translate: CollaborationTranslate
}) {
  return (
    <span
      data-testid={`cloud-todo-card-needs-execution-config-${itemId}`}
      className="mt-2 inline-flex w-fit items-center gap-1 rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {t('board.card.needs_configuration', '待配置')}
    </span>
  )
}

export function IssueBoardWorkflowStage({
  itemId,
  title,
  node,
  onOpen,
  onConfigureExecution,
  translate: t,
}: {
  itemId: string
  title: string
  node: SharedWorkflowNode | null
  onOpen?: () => void
  onConfigureExecution?: () => void
  translate: CollaborationTranslate
}) {
  return (
    <IssueCardWorkflowStage
      itemId={itemId}
      node={node}
      onOpen={onOpen}
      statusLabel={node ? workflowNodeStatusLabel(t, node.status) : undefined}
      configurationAction={
        onConfigureExecution ? (
          <button
            type="button"
            data-testid={`cloud-todo-card-configure-execution-${itemId}`}
            onClick={onConfigureExecution}
            className="ml-auto shrink-0 rounded-full bg-text-primary px-2.5 py-1 font-medium text-background transition hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
            aria-label={t('todo.configure_execution_for_item', '配置“{{title}}”的运行环境', {
              title,
            })}
          >
            {t('todo.configure_execution_action', '去配置')}
          </button>
        ) : undefined
      }
    />
  )
}

export function IssueBoardCardContent({
  item,
  reference,
  display,
  labels,
  agentNames,
  goal,
  needsExecutionConfiguration,
  workflowNode,
  translate: t,
}: Pick<CollaborationIssueCardProps, 'item' | 'reference' | 'display' | 'labels' | 'agentNames'> & {
  goal?: { bindingId: string | number; objective: string } | null
  needsExecutionConfiguration?: boolean
  workflowNode?: SharedWorkflowNode | null
  translate: CollaborationTranslate
}) {
  return (
    <>
      <CollaborationIssueCardContent
        item={item}
        reference={reference}
        display={display}
        labels={labels}
        agentNames={agentNames}
        renderAssigneeTooltip={(label, child) => (
          <Tooltip label={label} align="start" className="min-w-0 max-w-full">
            {child}
          </Tooltip>
        )}
        titleTrailing={
          goal?.objective.trim() ? (
            <IssueCardGoalSummary
              itemId={item.id}
              bindingId={goal.bindingId}
              objective={goal.objective}
              compact
              translate={t}
            />
          ) : null
        }
      />
      {needsExecutionConfiguration ? (
        <IssueExecutionConfigurationBadge itemId={item.id} translate={t} />
      ) : null}
      {workflowNode ? (
        <IssueBoardWorkflowStage
          itemId={item.id}
          title={item.title}
          node={workflowNode}
          translate={t}
        />
      ) : null}
    </>
  )
}
