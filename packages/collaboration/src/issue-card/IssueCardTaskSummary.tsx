import type { ReactNode } from 'react'
import { ListTodo, Target } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { ActivityShimmerText } from './ActivityShimmerText'

export interface IssueCardLiveActivity {
  active: boolean
  processText: string | null
  tools: { id: string; text: string; running: boolean }[]
}

export interface IssueCardTaskSummaryProps {
  itemId: string
  bindingId: string | number
  title: string
  compact: boolean
  focused?: boolean
  goal?: string | null
  goalLoading?: boolean
  activity: IssueCardLiveActivity
  responsePreview: string | null
  reserveTrailingAction?: boolean
  status?: ReactNode
  hideTaskIcon?: boolean
  conversation?: ReactNode
  translate: CollaborationTranslate
}

export function IssueCardTaskSummary({
  itemId,
  bindingId,
  title,
  compact,
  focused = false,
  goal,
  goalLoading,
  activity,
  responsePreview,
  reserveTrailingAction = false,
  status,
  hideTaskIcon = false,
  conversation,
  translate: t,
}: IssueCardTaskSummaryProps) {
  return (
    <div
      data-testid={`cloud-todo-card-task-summary-${itemId}-${bindingId}`}
      className={cn('min-w-0 text-left', compact && 'relative mt-3 empty:hidden')}
    >
      {status}
      {!compact ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
          {!hideTaskIcon ? <ListTodo className="h-3.5 w-3.5" /> : null}
          <span
            data-testid={`cloud-todo-card-task-${itemId}-${bindingId}`}
            className="min-w-0 flex-1 truncate"
            title={title}
          >
            {title}
          </span>
        </div>
      ) : null}
      {!compact && goal?.trim() ? (
        <IssueCardGoalSummary
          itemId={itemId}
          bindingId={bindingId}
          objective={goal}
          compact={false}
          translate={t}
        />
      ) : !compact && goalLoading ? (
        <div
          data-testid={`cloud-todo-card-popup-goal-loading-${itemId}-${bindingId}`}
          className="mt-2 text-xs leading-5 text-text-muted"
        >
          {t('todo.current_conversation_goal_loading', '正在加载会话目标…')}
        </div>
      ) : null}
      {compact && activity.active ? (
        <IssueCardCompactActivity
          itemId={itemId}
          activity={activity}
          responsePreview={responsePreview}
          reserveTrailingAction={reserveTrailingAction}
          focused={focused}
        />
      ) : !compact ? (
        <div className="mt-2 flex h-[min(68vh,42rem)] min-h-80 min-w-0 overflow-hidden">
          {conversation}
        </div>
      ) : responsePreview ? (
        <div
          data-testid={`cloud-todo-card-final-response-${itemId}`}
          className={cn(
            'text-xs leading-5 text-text-muted',
            'line-clamp-2 break-words',
            reserveTrailingAction && 'pr-7'
          )}
        >
          {responsePreview}
        </div>
      ) : null}
    </div>
  )
}

function IssueCardCompactActivity({
  itemId,
  activity,
  responsePreview,
  reserveTrailingAction,
  focused,
}: {
  itemId: string
  activity: IssueCardLiveActivity
  responsePreview: string | null
  reserveTrailingAction: boolean
  focused: boolean
}) {
  const processText = activity.processText || responsePreview
  const visibleTools = focused ? activity.tools.slice(-3) : activity.tools.slice(-1)

  return (
    <div data-testid={`cloud-todo-card-activity-${itemId}`} className="min-w-0 text-xs">
      {processText ? (
        <div
          data-testid={`cloud-todo-card-process-${itemId}`}
          className={cn(
            'whitespace-pre-wrap leading-5 text-text-secondary',
            focused ? 'line-clamp-[8]' : 'line-clamp-2',
            reserveTrailingAction && 'pr-7'
          )}
        >
          {processText}
        </div>
      ) : null}
      {visibleTools.length > 0 ? (
        <div
          data-testid={`cloud-todo-card-tool-line-${itemId}`}
          className={cn(
            'ml-2 min-w-0 border-l border-border pl-3 text-text-muted',
            processText && 'mt-1'
          )}
        >
          {visibleTools.map(block => (
            <IssueCardToolActivity key={block.id} itemId={itemId} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function IssueCardGoalSummary({
  itemId,
  bindingId,
  objective,
  compact,
  translate: t,
}: {
  itemId: string
  bindingId: string | number
  objective: string
  compact: boolean
  translate: CollaborationTranslate
}) {
  const label = t('todo.current_conversation_goal', '当前会话目标')

  if (compact) {
    return (
      <span
        data-testid={`cloud-todo-card-goal-${itemId}-${bindingId}`}
        className="inline-flex shrink-0 items-center text-text-secondary"
        title={`${label}: ${objective}`}
        aria-label={`${label}: ${objective}`}
      >
        <Target className="h-4 w-4" aria-hidden="true" />
      </span>
    )
  }

  return (
    <div
      data-testid={`cloud-todo-card-popup-goal-${itemId}-${bindingId}`}
      className="mt-2 flex min-w-0 gap-2 rounded-lg bg-muted/55 px-2.5 py-2"
    >
      <Target className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="min-w-0">
        <div className="text-xs font-medium leading-5 text-text-secondary">{label}</div>
        <p className="line-clamp-3 text-xs leading-5 text-text-primary">{objective}</p>
      </div>
    </div>
  )
}

function IssueCardToolActivity({
  itemId,
  block,
}: {
  itemId: string
  block: IssueCardLiveActivity['tools'][number]
}) {
  const running = block.running

  return (
    <div
      data-testid={`cloud-todo-card-tool-${itemId}-${block.id}`}
      className="flex h-5 min-w-0 items-center"
    >
      {running ? (
        <ActivityShimmerText variant="thinking" className="min-w-0 truncate">
          {block.text}
        </ActivityShimmerText>
      ) : (
        <span className="min-w-0 truncate">{block.text}</span>
      )}
    </div>
  )
}
