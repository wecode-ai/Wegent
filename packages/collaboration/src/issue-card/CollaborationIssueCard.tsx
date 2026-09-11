// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Bot, CalendarDays, Flag } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import {
  createCollaborationIssueCardModel,
  type CollaborationIssueCardDisplay,
  type CollaborationIssueCardItem,
  type CollaborationIssueCardLabels,
} from "./model";

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

export const collaborationIssueCardPriorityClasses: Record<
  CollaborationIssueCardItem["priority"],
  string
> = {
  none: "bg-muted text-text-secondary",
  low: "bg-muted text-text-secondary",
  medium: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  high: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  urgent: "bg-red-500/10 text-red-600 dark:text-red-400",
};

export function collaborationIssueCardClassName({
  className,
  dragging = false,
  dropTarget = false,
  unread = false,
}: {
  className?: string;
  dragging?: boolean;
  dropTarget?: boolean;
  unread?: boolean;
}): string {
  return classNames(
    "group relative h-fit w-full overflow-hidden rounded-xl border text-left shadow-sm transition-shadow hover:shadow-md",
    unread
      ? "border-focus/30 bg-focus/10 hover:border-focus/40 hover:bg-focus/[0.14]"
      : "border-border bg-background hover:border-text-primary/15",
    dragging && "opacity-25 shadow-none",
    dropTarget && !dragging && "border-focus ring-1 ring-focus/50",
    className,
  );
}

interface CollaborationIssueCardContentProps {
  agentNames?: Readonly<Record<string, string>>;
  display: CollaborationIssueCardDisplay;
  item: CollaborationIssueCardItem;
  labels: CollaborationIssueCardLabels;
  reference: string;
  renderAssigneeTooltip?: (label: string, child: ReactNode) => ReactNode;
  titleTrailing?: ReactNode;
}

export function CollaborationIssueCardContent({
  agentNames,
  display,
  item,
  labels,
  reference,
  renderAssigneeTooltip = (_label, child) => child,
  titleTrailing,
}: CollaborationIssueCardContentProps) {
  const model = createCollaborationIssueCardModel({
    agentNames,
    item,
    labels,
    reference,
  });
  return (
    <>
      {display.showReference !== false ? (
        <span
          data-testid={`cloud-todo-card-reference-${item.id}`}
          className="mb-1 block text-xs font-medium text-text-muted"
        >
          {model.reference}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-2 pr-5 text-base font-medium leading-5 text-text-primary">
        {model.unread ? (
          <span
            data-testid={`cloud-todo-card-unread-${item.id}`}
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
        ) : null}
        <span className="line-clamp-1 min-w-0">{model.title}</span>
        {titleTrailing}
      </span>
      {display.showTags && model.tags.length > 0 ? (
        <span className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {model.tags.slice(0, 2).map((tag, index) => (
            <span
              key={tag}
              className={classNames(
                "inline-flex h-5 max-w-28 shrink-0 items-center truncate rounded-md px-2 text-xs",
                index === 0
                  ? "bg-violet-500/10 text-violet-700 dark:text-violet-300"
                  : "bg-sky-500/10 text-sky-700 dark:text-sky-300",
              )}
            >
              {tag}
            </span>
          ))}
          {model.tags.length > 2 ? (
            <span className="shrink-0 text-xs text-text-muted">
              +{model.tags.length - 2}
            </span>
          ) : null}
        </span>
      ) : null}
      {display.showPriority || display.showDate || display.showAssignee ? (
        <span className="mt-2.5 flex min-h-6 items-center gap-3 text-xs text-text-muted">
          {display.showPriority ? (
            <span
              className={classNames(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5",
                collaborationIssueCardPriorityClasses[model.priority],
              )}
            >
              <Flag className="h-3 w-3" />
              {model.priorityLabel}
            </span>
          ) : null}
          {display.showDate && model.dueDate ? (
            <time
              dateTime={item.due_at ?? undefined}
              className="inline-flex items-center gap-1"
            >
              <CalendarDays className="h-3 w-3" />
              {model.dueDate}
            </time>
          ) : null}
          {display.showAssignee ? (
            model.assigneeName ? (
              renderAssigneeTooltip(
                model.assigneeName,
                <span
                  data-testid={`cloud-todo-card-assignee-${item.id}`}
                  className="ml-auto inline-flex min-w-0 shrink items-center gap-1.5"
                >
                  <span className="sr-only">{labels.assignee}</span>
                  {model.assigneeKind === "agent" ||
                  model.assigneeKind === "team" ? (
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                  ) : null}
                  <span className="truncate">{model.assigneeName}</span>
                </span>,
              )
            ) : (
              <span className="ml-auto">{labels.unassigned}</span>
            )
          ) : null}
        </span>
      ) : null}
    </>
  );
}

export interface CollaborationIssueCardProps extends CollaborationIssueCardContentProps {
  afterContent?: ReactNode;
  articleProps?: Omit<
    HTMLAttributes<HTMLElement>,
    "children" | "className" | "style"
  >;
  articleTestId?: string;
  cardClassName?: string;
  cardRef?: Ref<HTMLElement>;
  cardStyle?: CSSProperties;
  childrenAction?: ReactNode;
  detailButtonProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "className" | "type"
  >;
  detailButtonClassName?: string;
  detailButtonTestId?: string;
  detailFlushBottom?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  menu?: ReactNode;
}

export function CollaborationIssueCard({
  afterContent,
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
  ...contentProps
}: CollaborationIssueCardProps) {
  return (
    <article
      {...articleProps}
      ref={cardRef}
      data-testid={articleTestId}
      style={cardStyle}
      className={collaborationIssueCardClassName({
        className: cardClassName,
        dragging,
        dropTarget,
        unread: Boolean(contentProps.item.is_unread),
      })}
    >
      {menu}
      <button
        {...detailButtonProps}
        type="button"
        data-testid={detailButtonTestId}
        className={classNames(
          "w-full px-3.5 pt-3.5 text-left disabled:cursor-default",
          detailFlushBottom ? "pb-0" : "pb-3.5",
          detailButtonClassName,
        )}
      >
        <CollaborationIssueCardContent {...contentProps} />
        {afterContent}
      </button>
      {childrenAction}
    </article>
  );
}
