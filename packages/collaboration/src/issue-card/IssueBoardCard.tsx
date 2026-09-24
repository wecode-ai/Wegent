import { useIssueBoardCardDrag } from './useIssueBoardCardDrag'
import { useCollaborationPortalTheme } from '../theme'
import * as Popover from '@radix-ui/react-popover'
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowUpRight, Ellipsis, X } from 'lucide-react'
import { CollaborationIssueCard, type CollaborationIssueCardProps } from './CollaborationIssueCard'
import { IssueCardGoalSummary } from './IssueCardTaskSummary'
import { IssueBoardWorkflowStage, IssueExecutionConfigurationBadge } from './IssueBoardCardContent'
import { Tooltip } from '../issue-detail/Tooltip'
import type { SharedWorkflowNode } from '../issue-detail/workflowTypes'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

export interface IssueBoardCardTask {
  id: string | number
  task_title: string | null
  task_id: string
}
export interface IssueBoardCardProps<T extends IssueBoardCardTask> extends Omit<
  CollaborationIssueCardProps,
  | 'cardRef'
  | 'menu'
  | 'titleTrailing'
  | 'afterContent'
  | 'summary'
  | 'detailFlushBottom'
  | 'renderAssigneeTooltip'
  | 'item'
> {
  item: CollaborationIssueCardProps['item'] & { can_view_detail?: boolean }
  translate: CollaborationTranslate
  workflowNode?: SharedWorkflowNode | null
  needsExecutionConfiguration?: boolean
  onConfigureExecution?: () => void
  onArchive?: () => void
  archiveLabel?: string
  previewPinned?: boolean
  onPreviewPinnedChange?: (pinned: boolean) => void
  previewDisabled?: boolean
  showOpenTaskAction?: boolean
  dragEnabled?: boolean
  unread?: boolean
  onMarkRead?: () => void
  progressTaskBindings?: T[]
  goal?: { bindingId: string | number; objective: string } | null
  /** Bind task data to IssueCardTaskSummary; card and popup markup stay shared. */
  renderTaskSummary?: (binding: T, compact: boolean) => ReactNode
}

export function IssueBoardCard<T extends IssueBoardCardTask>({
  item,
  reference,
  display,
  labels,
  agentNames,
  translate: t,
  workflowNode = null,
  needsExecutionConfiguration = false,
  onConfigureExecution,
  onArchive,
  archiveLabel,
  previewPinned,
  onPreviewPinnedChange,
  previewDisabled = false,
  showOpenTaskAction = true,
  onMarkRead,
  unread,
  progressTaskBindings = [],
  goal,
  renderTaskSummary,
  cardStyle,
  cardClassName,
  dragging: draggingOverride = false,
  dragEnabled = false,
  dropTarget,
  articleProps,
  articleTestId,
  detailButtonProps,
  detailButtonTestId,
  onOpen,
  childrenAction,
}: IssueBoardCardProps<T>) {
  const drag = useIssueBoardCardDrag(item.id, dragEnabled)
  const dragging = draggingOverride || drag.dragging
  const portalTheme = useCollaborationPortalTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = (event: MouseEvent) => {
      if (!menuContainerRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeMenu)
    return () => document.removeEventListener('mousedown', closeMenu)
  }, [menuOpen])
  const [localPreviewOpen, setLocalPreviewOpen] = useState(false)
  const requestedPreviewOpen = previewPinned ?? localPreviewOpen
  const setPreviewOpen = useCallback(
    (open: boolean) => {
      setLocalPreviewOpen(open)
      onPreviewPinnedChange?.(open)
    },
    [onPreviewPinnedChange]
  )
  const popupRef = useRef<HTMLDivElement>(null)
  const cardContainerRef = useRef<HTMLDivElement>(null)
  const markReadRef = useRef(onMarkRead)
  useEffect(() => {
    markReadRef.current = onMarkRead
  }, [onMarkRead])
  const showWorkflowRow = Boolean(
    workflowNode || (needsExecutionConfiguration && onConfigureExecution)
  )
  const hasProgress =
    item.can_view_detail !== false && progressTaskBindings.length > 0 && Boolean(renderTaskSummary)
  const previewAvailable = hasProgress && !previewDisabled && !drag.boardDragging && !dragging
  const previewOpen = previewAvailable && requestedPreviewOpen
  const canOpenItem = item.can_view_detail !== false
  const openItem = canOpenItem ? onOpen : undefined
  const activateCard = previewAvailable ? () => setPreviewOpen(true) : openItem
  if (!previewAvailable && localPreviewOpen) setLocalPreviewOpen(false)
  useEffect(() => {
    if (!previewAvailable && previewPinned) onPreviewPinnedChange?.(false)
  }, [previewAvailable, previewPinned, onPreviewPinnedChange])
  const canMarkRead = Boolean(onMarkRead)
  const isUnread = unread ?? Boolean(item.is_unread)
  useEffect(() => {
    if (!previewOpen || !isUnread || !canMarkRead) return
    const timer = window.setTimeout(() => markReadRef.current?.(), 3000)
    return () => window.clearTimeout(timer)
  }, [isUnread, canMarkRead, previewOpen])
  const card = (
    <CollaborationIssueCard
      item={item}
      unread={isUnread}
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
      afterContent={
        needsExecutionConfiguration ? (
          <IssueExecutionConfigurationBadge itemId={item.id} translate={t} />
        ) : null
      }
      summary={
        hasProgress ? (
          <div data-testid={`cloud-todo-card-tasks-${item.id}`} className="min-w-0">
            {progressTaskBindings.map(binding => (
              <Fragment key={binding.id}>{renderTaskSummary?.(binding, true)}</Fragment>
            ))}
          </div>
        ) : null
      }
      cardRef={drag.setNodeRef}
      cardStyle={dragEnabled ? { ...cardStyle, ...drag.style } : cardStyle}
      cardClassName={[cardClassName, 'group/issue-board-card', dragEnabled && 'touch-none']
        .filter(Boolean)
        .join(' ')}
      dragging={dragging}
      dropTarget={dropTarget || drag.dropTarget}
      articleProps={articleProps}
      articleTestId={articleTestId ?? `cloud-todo-card-drop-${item.id}`}
      menu={
        onArchive ? (
          <div ref={menuContainerRef} className="absolute right-2 top-2 z-20">
            <Tooltip label={t('todo.project_actions', '项目操作')} side="bottom" align="end">
              <button
                type="button"
                data-testid={`cloud-todo-card-more-${item.id}`}
                onClick={event => {
                  event.stopPropagation()
                  setMenuOpen(current => !current)
                }}
                className="pointer-events-none flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-text-muted opacity-0 shadow-sm transition hover:text-text-primary focus:pointer-events-auto focus:opacity-100 group-hover/issue-board-card:pointer-events-auto group-hover/issue-board-card:opacity-100"
                aria-label={t('todo.project_actions', '项目操作')}
                aria-expanded={menuOpen}
              >
                <Ellipsis className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
            {menuOpen ? (
              <div
                data-testid={`cloud-todo-card-menu-${item.id}`}
                className="absolute right-0 top-8 w-32 rounded-lg border border-border bg-background p-1 shadow-md"
              >
                <button
                  type="button"
                  data-testid={`cloud-todo-card-archive-${item.id}`}
                  onClick={event => {
                    event.stopPropagation()
                    setMenuOpen(false)
                    onArchive?.()
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-red-600 hover:bg-muted"
                >
                  <Archive className="h-3.5 w-3.5" />
                  {archiveLabel ?? t('board.card.archive', '归档任务')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null
      }
      detailFlushBottom={showWorkflowRow}
      detailButtonTestId={detailButtonTestId ?? `cloud-todo-card-${item.id}`}
      detailButtonClassName="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/30"
      onOpen={canOpenItem ? activateCard : undefined}
      detailButtonProps={{
        ...detailButtonProps,
        ...drag.buttonProps,
        'aria-controls': previewAvailable ? `cloud-todo-card-progress-popup-${item.id}` : undefined,
        'aria-expanded': previewAvailable ? previewOpen : undefined,
        'aria-haspopup': previewAvailable ? 'dialog' : undefined,
        'aria-disabled': !canOpenItem || undefined,
        disabled: !canOpenItem || detailButtonProps?.disabled,
      }}
      childrenAction={
        <>
          {childrenAction}
          {showWorkflowRow ? (
            <span className="block px-3.5 pb-3">
              <IssueBoardWorkflowStage
                itemId={item.id}
                title={item.title}
                node={workflowNode}
                translate={t}
                onOpen={item.can_view_detail === false ? undefined : onOpen}
                onConfigureExecution={
                  needsExecutionConfiguration ? onConfigureExecution : undefined
                }
              />
            </span>
          ) : null}
          {showOpenTaskAction && progressTaskBindings.length > 0 && openItem ? (
            <span className="absolute bottom-2 right-2 z-20">
              <Tooltip
                label={t('todo.open_task_page_named', '打开任务页：{{title}}', {
                  title: item.title,
                })}
                side="bottom"
                align="end"
              >
                <button
                  type="button"
                  data-testid={`cloud-todo-card-open-task-${item.id}`}
                  aria-label={t('todo.open_task_page_named', '打开任务页：{{title}}', {
                    title: item.title,
                  })}
                  onClick={event => {
                    event.stopPropagation()
                    setPreviewOpen(false)
                    openItem()
                  }}
                  className="pointer-events-none flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-text-muted opacity-0 shadow-sm transition hover:bg-muted hover:text-text-primary hover:opacity-100 focus:pointer-events-auto focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover/issue-board-card:pointer-events-auto group-hover/issue-board-card:opacity-100 max-md:pointer-events-auto max-md:min-h-11 max-md:min-w-11 max-md:opacity-60"
                >
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </Tooltip>
            </span>
          ) : null}
        </>
      }
    />
  )

  return (
    <Popover.Root open={previewOpen} onOpenChange={setPreviewOpen}>
      <Popover.Anchor asChild>
        <div ref={cardContainerRef}>{card}</div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          {...portalTheme}
          id={`cloud-todo-card-progress-popup-${item.id}`}
          data-testid={`cloud-todo-card-progress-popup-${item.id}`}
          data-pinned="true"
          aria-label={t('todo.view_task_progress_named', '查看进展：{{title}}', {
            title: item.title,
          })}
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={event => {
            event.preventDefault()
            popupRef.current?.focus()
          }}
          onInteractOutside={event => {
            event.preventDefault()
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            cardContainerRef.current
              ?.querySelector<HTMLButtonElement>(`[data-testid="cloud-todo-card-${item.id}"]`)
              ?.focus()
          }}
          ref={popupRef}
          tabIndex={-1}
          className={`${portalTheme.className} relative z-[78] w-[480px] max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-border bg-background p-3 text-xs text-text-primary shadow-lg outline-none`}
        >
          <Popover.Close asChild>
            <button
              type="button"
              data-testid={`cloud-todo-card-progress-popup-${item.id}-close`}
              aria-label={t('common.close', '关闭')}
              className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </Popover.Close>
          {renderTaskSummary ? (
            <IssueBoardCardProgressPopup
              item={item}
              bindings={progressTaskBindings}
              renderTaskSummary={renderTaskSummary}
              translate={t}
            />
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function IssueBoardCardProgressPopup<T extends IssueBoardCardTask>({
  item,
  bindings,
  renderTaskSummary,
  translate: t,
}: {
  item: { id: string; title: string }
  bindings: T[]
  renderTaskSummary: (binding: T, compact: boolean) => ReactNode
  translate: CollaborationTranslate
}) {
  const [selectedBindingId, setSelectedBindingId] = useState<string | number | null>(null)
  const selectedBinding = bindings.find(binding => binding.id === selectedBindingId) ?? bindings[0]
  const visibleBindings = selectedBinding ? [selectedBinding] : []

  return (
    <div
      data-testid={`cloud-todo-card-progress-popup-content-${item.id}`}
      className="min-w-0 space-y-2"
    >
      <div className="flex min-w-0 items-start gap-2 border-b border-border/60 pb-2 pr-8">
        <div className="min-w-0 flex-1">
          <div
            data-testid={`cloud-todo-card-progress-title-${item.id}`}
            className="truncate text-sm font-medium leading-5 text-text-primary"
            title={item.title}
          >
            {item.title}
          </div>
          {bindings.length > 1 ? (
            <div className="mt-0.5 text-xs leading-5 text-text-secondary">
              {t('todo.task_progress_count', '{{count}} 个任务', {
                count: bindings.length,
              })}
            </div>
          ) : null}
        </div>
      </div>
      {bindings.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {bindings.map(binding => (
            <button
              key={binding.id}
              type="button"
              data-testid={`cloud-todo-card-progress-select-${item.id}-${binding.id}`}
              aria-pressed={binding.id === selectedBinding?.id}
              onClick={() => setSelectedBindingId(binding.id)}
              className={cn(
                'min-h-7 max-w-full truncate rounded-md px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30',
                binding.id === selectedBinding?.id && 'bg-muted'
              )}
            >
              {binding.task_title || binding.task_id}
            </button>
          ))}
        </div>
      ) : null}
      {visibleBindings.length > 0 ? (
        <div data-testid={`cloud-todo-card-progress-list-${item.id}`} className="space-y-1">
          {visibleBindings.map(binding => (
            <div
              key={binding.id}
              data-testid={`cloud-todo-card-progress-task-${item.id}-${binding.id}`}
              className="p-1"
            >
              {renderTaskSummary(binding, false)}
            </div>
          ))}
        </div>
      ) : (
        <p
          data-testid={`cloud-todo-card-progress-empty-${item.id}`}
          className="text-xs leading-5 text-text-muted"
        >
          {t('todo.task_progress_empty', '暂无任务进展详情')}
        </p>
      )}
    </div>
  )
}
