// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, Circle, Clock3, Flag, Ghost, UserRound, UsersRound } from 'lucide-react'
import { issueHumanAssignees, issueParticipation } from '../issueParticipation'
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

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(' ')
}

export function WaitingForPersonIcon() {
  return (
    <span
      className="relative inline-block h-3.5 w-3.5 shrink-0"
      aria-hidden="true"
    >
      <UserRound className="h-3.5 w-3.5" />
      <Clock3 className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-background" />
    </span>
  )
}

const priorityClasses: Record<CollaborationIssueCardItem['priority'], string> =
  {
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
  variant = 'card',
}: {
  className?: string
  dragging?: boolean
  dropTarget?: boolean
  unread?: boolean
  variant?: 'card' | 'list'
}): string {
  return classNames(
    'group relative h-fit w-full text-left transition-colors',
    variant === 'card' && 'overflow-hidden rounded-xl border',
    variant === 'list'
      ? 'border-b border-border/60 bg-background hover:bg-text-primary/[0.025]'
      : unread
        ? 'border-focus/30 bg-focus/10 hover:border-focus/40 hover:bg-focus/[0.14]'
        : 'border-border bg-background hover:border-text-primary/15',
    dragging && 'opacity-25 shadow-none',
    dropTarget && !dragging && 'border-focus ring-1 ring-focus/50',
    className,
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
        participant={
          <IssueCardParticipation item={item} labels={labels} model={model} />
        }
      />
      <IssueCardMetadata
        item={item}
        itemId={item.id}
        model={model}
        display={display}
        labels={labels}
        renderAssigneeTooltip={renderAssigneeTooltip}
      />
    </>
  )
}

function IssueCardParticipation({
  item,
  labels,
  model,
}: Pick<CollaborationIssueCardContentProps, 'item' | 'labels'> & {
  model: CollaborationIssueCardModel
}) {
  const state = issueParticipation(item)
  const text = labels.participation
  if (!state || !text) return null
  const names =
    state === 'human'
      ? [
          ...new Set(issueHumanAssignees(item).map((person) => person.name)),
        ].join('、')
      : item.processing_actor?.name || item.ai_state?.agent_name
  if (!names) return null
  const kind =
    state === 'human'
      ? 'human'
      : item.processing_actor?.kind === 'stand_in'
        ? 'stand_in'
        : 'agent'
  const label =
    kind === 'human'
      ? text.human(names)
      : `${kind === 'stand_in' ? text.standIn : text.agent}: ${names}`
  const Icon = kind === 'stand_in' ? Ghost : Bot
  return (
    <span
      data-testid={`issue-participation-${item.id}`}
      data-processing-kind={kind}
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex min-w-0 max-w-full items-center gap-1 text-xs font-normal text-text-secondary"
    >
      {kind === 'human' ? (
        <WaitingForPersonIcon />
      ) : (
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      {names === model.assigneeName ? (
        <span className="sr-only">{labels.assignee}</span>
      ) : null}
      <span
        className="truncate"
        data-testid={
          names === model.assigneeName
            ? `cloud-todo-card-assignee-${item.id}`
            : undefined
        }
      >
        {names}
      </span>
    </span>
  )
}

function IssueCardHeading({
  itemId,
  model,
  display,
  titleTrailing,
  unread,
  participant,
  variant = 'card',
  metadata,
}: {
  itemId: string
  model: CollaborationIssueCardModel
  display: CollaborationIssueCardDisplay
  titleTrailing?: ReactNode
  unread?: boolean
  participant?: ReactNode
  variant?: 'card' | 'list'
  metadata?: ReactNode
}) {
  const showPriority =
    display.showPriority &&
    (model.priority === 'high' || model.priority === 'urgent')
  const tags = display.showTags ? model.tags : []
  const statusLabel = model.statusLabel
  if (variant === 'list')
    return (
      <span
        data-testid={`cloud-todo-card-header-${itemId}`}
        className="flex min-w-0 flex-col gap-1.5"
      >
        <span className="flex min-w-0 items-start gap-2">
          {(unread ?? model.unread) && (
            <span
              data-testid={`cloud-todo-card-unread-${itemId}`}
              aria-hidden="true"
              className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            />
          )}
          <span className="line-clamp-2 min-w-0 break-words text-heading-sm font-medium leading-6 text-text-primary">
            {model.title}
          </span>
          {display.showReference !== false && (
            <span
              data-testid={`cloud-todo-card-reference-${itemId}`}
              className="shrink-0 pt-1 text-sm text-text-muted"
            >
              {model.shortReference}
            </span>
          )}
          {titleTrailing}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-muted">
          {statusLabel && (
            <span data-testid={`cloud-todo-card-status-${itemId}`} className="inline-flex items-center gap-1.5 text-text-secondary">
              <Circle aria-hidden="true" className="h-3 w-3 text-text-muted" />
              {statusLabel}
            </span>
          )}
          {participant}
          {metadata}
          {showPriority && (
            <span className={classNames('inline-flex items-center gap-1', priorityClasses[model.priority])}>
              <Flag aria-hidden="true" className="h-3 w-3" />
              {model.priorityLabel}
            </span>
          )}
          {tags.length > 0 && (
            <span className="min-w-0 truncate" title={tags.join(', ')}>
              {tags.join(' · ')}
            </span>
          )}
        </span>
      </span>
    )
  return (
    <>
      {statusLabel ||
      display.showReference !== false ||
      tags.length > 0 ||
      showPriority ? (
        <span
          data-testid={`cloud-todo-card-header-${itemId}`}
          className="mb-1.5 flex min-w-0 items-center gap-2 pr-5 text-xs text-text-muted"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {display.showReference !== false ? (
              <span
                data-testid={`cloud-todo-card-reference-${itemId}`}
                title={model.reference}
                className="max-w-[50%] shrink-0 truncate"
              >
                {model.shortReference}
              </span>
            ) : null}
            {statusLabel && (
              <span
                data-testid={`cloud-todo-card-status-${itemId}`}
                title={statusLabel}
                className="max-w-[40%] shrink-0 truncate rounded bg-muted px-1.5 py-0.5"
              >
                {statusLabel}
              </span>
            )}
            {tags.length > 0 ? (
              <span className="min-w-0 truncate" title={tags.join(', ')}>
                {tags[0]}
              </span>
            ) : null}
            {tags.length > 1 ? (
              <span className="shrink-0">+{tags.length - 1}</span>
            ) : null}
          </span>
          <span
            data-testid={`cloud-todo-card-header-actors-${itemId}`}
            className="ml-auto inline-flex min-w-0 max-w-[50%] shrink-0 items-center gap-2"
          >
            {showPriority ? (
              <span
                className={classNames(
                  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap',
                  priorityClasses[model.priority],
                )}
              >
                <Flag className="h-3 w-3 shrink-0" aria-hidden="true" />
                {model.priorityLabel}
              </span>
            ) : null}
            {participant}
          </span>
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
  item,
  itemId,
  model,
  display,
  labels,
  renderAssigneeTooltip = (_label, child) => child,
  variant = 'card',
}: {
  item: CollaborationIssueCardItem
  itemId: string
  model: CollaborationIssueCardModel
  display: CollaborationIssueCardDisplay
  labels: CollaborationIssueCardLabels
  renderAssigneeTooltip?: CollaborationIssueCardContentProps['renderAssigneeTooltip']
  variant?: 'card' | 'list'
}) {
  const state = issueParticipation(item)
  const actorName =
    state === 'human'
      ? [
          ...new Set(issueHumanAssignees(item).map((person) => person.name)),
        ].join('、')
      : state === 'ai'
        ? item.processing_actor?.name || item.ai_state?.agent_name
        : null
  const showAssignee =
    display.showAssignee &&
    (!labels.participation ||
      !actorName ||
      Boolean(model.assigneeName && actorName !== model.assigneeName))
  if (!showAssignee && !(display.showDate && model.date)) return null
  const dateDescription = model.date
    ? `${labels.createdAt}: ${model.date.value}`
    : undefined
  return (
    <span
      data-testid={`cloud-todo-card-metadata-${itemId}`}
      className={classNames(
        'min-w-0 items-center gap-3 text-xs text-text-muted',
        variant === 'list'
          ? 'flex flex-wrap'
          : 'mt-3 grid grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      {showAssignee ? (
        model.assigneeName ? (
          renderAssigneeTooltip(
            model.assigneeName,
            <span
              data-testid={`cloud-todo-card-assignee-${itemId}`}
              className="inline-flex min-w-0 max-w-full items-center gap-1.5"
            >
              <span className="sr-only">{labels.assignee}</span>
              {model.assigneeKind === 'group' ? (
                <UsersRound
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
              ) : model.assigneeKind === 'agent' ||
                model.assigneeKind === 'team' ? (
                <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <UserRound
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{model.assigneeName}</span>
            </span>,
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
  variant?: 'card' | 'list'
  afterContent?: ReactNode
  summary?: ReactNode
  metadata?: ReactNode
  articleProps?: Omit<
    HTMLAttributes<HTMLElement>,
    'children' | 'className' | 'style'
  >
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
  variant,
  afterContent,
  summary,
  metadata,
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
      onClick={(event) => {
        const target = event.target
        // Portal events bubble through React even when their DOM is outside the card.
        if (
          !(target instanceof Element) ||
          !event.currentTarget.contains(target)
        )
          return
        articleProps?.onClick?.(event)
        if (event.defaultPrevented || !canOpenDetails || dragging) return
        const control = target.closest(
          'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [contenteditable]:not([contenteditable="false"])',
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
        variant,
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
          'w-full cursor-default text-left',
          variant === 'list' ? 'px-8 pt-3' : 'px-3.5 pt-3.5',
          detailButtonClassName,
        )}
      >
        <IssueCardHeading
          variant={variant}
          itemId={contentProps.item.id}
          model={model}
          display={contentProps.display}
          titleTrailing={contentProps.titleTrailing}
          unread={unread}
          metadata={variant === 'list' ? (
            <IssueCardMetadata
              variant="list"
              item={contentProps.item}
              itemId={contentProps.item.id}
              model={model}
              display={contentProps.display}
              labels={contentProps.labels}
              renderAssigneeTooltip={contentProps.renderAssigneeTooltip}
            />
          ) : undefined}
          participant={
            <IssueCardParticipation
              item={contentProps.item}
              labels={contentProps.labels}
              model={model}
            />
          }
        />
        {afterContent}
      </button>
      <div
        className={classNames(variant === 'list' ? 'px-8' : 'px-3.5', detailFlushBottom ? 'pb-0' : variant === 'list' ? 'pb-3' : 'pb-3.5')}
      >
        {summary}
        {metadata}
        {variant !== 'list' && <IssueCardMetadata
          variant={variant}
          item={contentProps.item}
          itemId={contentProps.item.id}
          model={model}
          display={contentProps.display}
          labels={contentProps.labels}
          renderAssigneeTooltip={contentProps.renderAssigneeTooltip}
        />}
      </div>
      {childrenAction}
    </article>
  )
}
