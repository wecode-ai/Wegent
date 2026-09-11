// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType, ReactNode, SVGProps } from "react";

import { collaborationMyWorkMessages, type CollaborationLocale } from "../i18n";
import {
  buildMyWorkCalendarEntries,
  MyWorkView,
  type MyWorkItem,
} from "../my-work";
import type { WorkspaceMyWorkItem } from "../ports/SharedWorkspaceApi";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      {...props}
    >
      {children}
    </svg>
  );
}

function icon(children: ReactNode): ComponentType<IconProps> {
  return function MyWorkIcon(props: IconProps) {
    return <Icon {...props}>{children}</Icon>;
  };
}

const icons = {
  group: icon(
    <>
      <rect width="7" height="7" x="3" y="3" rx="1" />
      <rect width="7" height="7" x="14" y="3" rx="1" />
      <rect width="7" height="7" x="3" y="14" rx="1" />
      <rect width="7" height="7" x="14" y="14" rx="1" />
    </>,
  ),
  list: icon(
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </>,
  ),
  calendar: icon(
    <>
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </>,
  ),
  timeline: icon(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>,
  ),
};

const ACTIVE_EXECUTION_STATES = new Set([
  "assigned",
  "cancel_requested",
  "cancelling",
  "claimed",
  "in_progress",
  "pending",
  "pending_approval",
  "queued",
  "running",
  "starting",
  "streaming",
  "unknown",
  "waiting_approval",
  "waiting_device",
  "waiting_runtime",
]);

function isExecutionStateActive(state: string | null | undefined): boolean {
  return state != null && ACTIVE_EXECUTION_STATES.has(state.toLowerCase());
}

function CalendarView<T extends MyWorkItem>({
  items,
  onSelectItem,
}: {
  items: readonly T[];
  onSelectItem(item: T): void;
}) {
  const entries = buildMyWorkCalendarEntries(items, isExecutionStateActive);
  return (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm"
      data-testid="my-work-calendar"
    >
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted/60"
          data-testid={`my-work-calendar-item-${entry.id}`}
          onClick={() => onSelectItem(entry.item)}
        >
          <time
            className="w-28 shrink-0 text-xs text-text-muted"
            dateTime={entry.start}
          >
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
            }).format(new Date(entry.start))}
          </time>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {entry.title}
          </span>
          <span className="shrink-0 text-xs text-text-muted">
            {entry.item.project_name}
          </span>
        </button>
      ))}
    </div>
  );
}

export interface MyWorkAdapterProps {
  items: WorkspaceMyWorkItem[];
  locale: CollaborationLocale;
  onBack(): void;
  onSelectItem(item: WorkspaceMyWorkItem): void;
}

export function MyWorkAdapter({
  items,
  locale,
  onBack,
  onSelectItem,
}: MyWorkAdapterProps) {
  const translations = collaborationMyWorkMessages[locale];
  const translate = (key: string, fallback: string) =>
    translations[key] ?? fallback;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        className="collaboration-link-button absolute left-8 top-2 z-20"
        data-testid="collaboration-my-work-back"
        onClick={onBack}
      >
        ← {translate("collaboration.back_to_projects", "返回项目首页")}
      </button>
      <MyWorkView
        items={items}
        locale={locale}
        translate={translate}
        icons={icons}
        isExecutionStateActive={isExecutionStateActive}
        onSelectItem={onSelectItem}
        renderCalendar={(props) => <CalendarView {...props} />}
      />
    </div>
  );
}
