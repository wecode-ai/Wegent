// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Clock3, Flag, UserRound } from 'lucide-react'
import {
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import {
  createCollaborationIssueCardModel,
  type CollaborationIssueCardDisplay,
  type CollaborationIssueCardItem,
  type CollaborationIssueCardLabels,
  type CollaborationIssueCardModel,
} from './model'

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

const priorityClasses: Record<CollaborationIssueCardItem['priority'], string> = {
  none: 'text-text-secondary',
  low: 'text-text-secondary',
  medium: 'text-text-secondary',
  high: 'text-amber-600 dark:text-amber-400',
  urgent: 'text-red-600 dark:text-red-400',
}

function collaborationIssueCardClassName({
  className,
  dragging = false,
  dropTarget = false,
  unread = false,
}: {
  className?: string
  dragging?: boolean
  dropTarget?: boolean
  unread?: boolean
}): string {
  return classNames(
    'group relative h-fit w-full overflow-hidden rounded-xl border text-left transition-colors',
    unread
      ? 'border-focus/30 bg-focus/10 hover:border-focus/40 hover:bg-focus/[0.14]'
      : 'border-border bg-background hover:border-text-primary/15',
    dragging && 'opacity-25 shadow-none',
    dropTarget && !dragging && 'border-focus ring-1 ring-focus/50',
    className
  )
}

interface CollaborationIssueCardContentProps {
  agentNames?: Readonly<Record<string, string>>
  display: CollaborationIssueCardDisplay
  item: CollaborationIssueCardItem
  labels: CollaborationIssueCardLabels
  reference: string
  renderAssigneeTooltip?: (label: string, child: ReactNode) => ReactNode
  titleTrailing?: ReactNode
  unread?: boolean
}

export function CollaborationIssueCardContent({
  agentNames,
  display,
  item,
  labels,
  reference,
  renderAssigneeTooltip = (_label, child) => child,
  titleTrailing,
  unread,
}: CollaborationIssueCardContentProps) {
  const model = createCollaborationIssueCardModel({
    agentNames,
    item,
    labels,
    reference,
  })
  return (
    <>
      <IssueCardHeading
        itemId={item.id}
        model={model}
        display={display}
        titleTrailing={titleTrailing}
        unread={unread}
      />
      <IssueCardMetadata
        itemId={item.id}
        model={model}
        display={display}
        labels={labels}
        renderAssigneeTooltip={renderAssigneeTooltip}
      />
    </>
  )
}

function IssueCardHeading({
  itemId,
  model,
  display,
  titleTrailing,
  unread,
}: {
  itemId: string
  model: CollaborationIssueCardModel
  display: CollaborationIssueCardDisplay
  titleTrailing?: ReactNode
  unread?: boolean
}) {
  const showPriority =
    display.showPriority && (model.priority === 'high' || model.priority === 'urgent')
  const tags = display.showTags ? model.tags : []
  return (
    <>
      {display.showReference !== false || tags.length > 0 || showPriority ? (
        <span className="mb-1.5 flex min-w-0 items-center gap-2 pr-5 text-xs text-text-muted">
          {display.showReference !== false ? (
            <span
              data-testid={`cloud-todo-card-reference-${itemId}`}
              title={model.reference}
              className="max-w-[50%] shrink-0 truncate"
            >
              {model.shortReference}
            </span>
          ) : null}
          {tags.length > 0 ? (
            <span className="min-w-0 truncate" title={tags.join(', ')}>
              {tags[0]}
            </span>
          ) : null}
          {tags.length > 1 ? <span className="shrink-0">+{tags.length - 1}</span> : null}
          {showPriority ? (
            <span
              className={classNames(
                'ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap',
                priorityClasses[model.priority]
              )}
            >
              <Flag className="h-3 w-3 shrink-0" aria-hidden="true" />
              {model.priorityLabel}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex min-w-0 items-start gap-2 pr-5 text-base font-medium leading-5 text-text-primary">
        {(unread ?? model.unread) ? (
          <span
            data-testid={`cloud-todo-card-unread-${itemId}`}
            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        ) : null}
        <span className="line-clamp-2 min-w-0 break-words">{model.title}</span>
        {titleTrailing}
      </span>
    </>
  )
}

function IssueCardMetadata({
  itemId,
  model,
  display,
  labels,
  renderAssigneeTooltip = (_label, child) => child,
}: {
  itemId: string
  model: CollaborationIssueCardModel
  display: CollaborationIssueCardDisplay
  labels: CollaborationIssueCardLabels
  renderAssigneeTooltip?: CollaborationIssueCardContentProps['renderAssigneeTooltip']
}) {
  if (!display.showAssignee && !(display.showDate && model.date)) return null
  const dateDescription = model.date ? `${labels.createdAt}: ${model.date.value}` : undefined
  return (
    <span
      data-testid={`cloud-todo-card-metadata-${itemId}`}
      className="mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs text-text-muted"
    >
      {display.showAssignee ? (
        model.assigneeName ? (
          renderAssigneeTooltip(
            model.assigneeName,
            <span
              data-testid={`cloud-todo-card-assignee-${itemId}`}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5"
            >
              <span className="sr-only">{labels.assignee}</span>
              {model.assigneeKind === 'agent' || model.assigneeKind === 'team' ? (
                <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{model.assigneeName}</span>
            </span>
          )
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{labels.unassigned}</span>
          </span>
        )
      ) : (
        <span />
      )}
      {display.showDate && model.date ? (
        <time
          dateTime={model.date.value}
          title={dateDescription}
          aria-label={dateDescription}
          className="inline-flex items-center gap-1 whitespace-nowrap"
        >
          <Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" />
          {model.date.label}
        </time>
      ) : null}
    </span>
  )
}

export interface CollaborationIssueCardProps extends CollaborationIssueCardContentProps {
  afterContent?: ReactNode
  summary?: ReactNode
  articleProps?: Omit<HTMLAttributes<HTMLElement>, 'children' | 'className' | 'style'>
  articleTestId?: string
  cardClassName?: string
  cardRef?: Ref<HTMLElement>
  cardStyle?: CSSProperties
  childrenAction?: ReactNode
  detailButtonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'children' | 'className' | 'type' | 'onClick'
  >
  detailButtonClassName?: string
  detailButtonTestId?: string
  detailFlushBottom?: boolean
  dragging?: boolean
  dropTarget?: boolean
  menu?: ReactNode
  onOpen?: () => void
  unread?: boolean
}

export function CollaborationIssueCard({
  afterContent,
  summary,
  articleProps,
  articleTestId,
  cardClassName,
  cardRef,
  cardStyle,
  childrenAction,
  detailButtonClassName,
  detailButtonProps,
  detailButtonTestId,
  detailFlushBottom = false,
  dragging,
  dropTarget,
  menu,
  onOpen,
  unread,
  ...contentProps
}: CollaborationIssueCardProps) {
  const detailButtonRef = useRef<HTMLButtonElement>(null)
  const canOpenDetails = Boolean(onOpen) && !detailButtonProps?.disabled
  const model = createCollaborationIssueCardModel(contentProps)

  return (
    <article
      {...articleProps}
      onClick={event => {
        const target = event.target
        // Portal events bubble through React even when their DOM is outside the card.
        if (!(target instanceof Element) || !event.currentTarget.contains(target)) return
        articleProps?.onClick?.(event)
        if (event.defaultPrevented || !canOpenDetails || dragging) return
        const control = target.closest(
          'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [contenteditable]:not([contenteditable="false"])'
        )
        if (control && event.currentTarget.contains(control)) return
        detailButtonRef.current?.focus({ preventScroll: true })
        onOpen?.()
      }}
      ref={cardRef}
      data-testid={articleTestId}
      style={cardStyle}
      className={collaborationIssueCardClassName({
        className: classNames('cursor-default', cardClassName),
        dragging,
        dropTarget,
        unread: unread ?? Boolean(contentProps.item.is_unread),
      })}
    >
      {menu}
      <button
        {...detailButtonProps}
        onClick={onOpen}
        ref={detailButtonRef}
        type="button"
        data-testid={detailButtonTestId}
        className={classNames(
          'w-full cursor-default px-3.5 pt-3.5 text-left',
          detailButtonClassName
        )}
      >
        <IssueCardHeading
          itemId={contentProps.item.id}
          model={model}
          display={contentProps.display}
          titleTrailing={contentProps.titleTrailing}
          unread={unread}
        />
        {afterContent}
      </button>
      <div className={classNames('px-3.5', detailFlushBottom ? 'pb-0' : 'pb-3.5')}>
        {summary}
        <IssueCardMetadata
          itemId={contentProps.item.id}
          model={model}
          display={contentProps.display}
          labels={contentProps.labels}
          renderAssigneeTooltip={contentProps.renderAssigneeTooltip}
        />
      </div>
      {childrenAction}
    </article>
  )
}
