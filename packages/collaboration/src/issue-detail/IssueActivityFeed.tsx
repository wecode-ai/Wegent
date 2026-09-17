import { ArrowDownUp, Hash, MessageSquareText } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { CollaborationTranslate } from "../i18n";
import { activityClassNames as cn } from "./activityClassNames";
import { CompositedSpinner } from "./CompositedSpinner";

/** Desktop activity layout; hosts supply records, execution controls and composers. */
export function IssueActivityFeed({
  mode = "linear",
  testId,
  listTestId,
  listRef,
  translate: t,
  count,
  loading,
  emptyDescription,
  error,
  tools,
  composer,
  children,
}: {
  mode?: "linear" | "rail" | "document";
  testId: string;
  listTestId: string;
  listRef?: Ref<HTMLDivElement>;
  translate: CollaborationTranslate;
  count: number;
  loading: boolean;
  emptyDescription: string;
  error?: string | null;
  tools?: ReactNode;
  composer: ReactNode;
  children: ReactNode;
}) {
  const rail = mode === "rail";
  const linear = mode === "linear";
  const compact = rail || linear;
  return (
    <section
      data-testid={testId}
      className={cn(
        rail && "flex h-full min-h-0 flex-col max-md:block",
        linear && "task-detail-comments",
        !compact && "mt-8 border-t border-border pt-6",
      )}
    >
      <header
        className={cn(
          "flex min-h-8 items-center gap-3",
          rail && "shrink-0 bg-muted/40 px-[18px] pb-[10px] pt-[14px]",
          linear && "task-detail-comments-head",
        )}
      >
        <span
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-lg bg-muted text-text-secondary",
            compact && "hidden",
          )}
        >
          <Hash className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "block font-semibold text-text-primary",
              compact ? "text-base" : "text-sm",
            )}
          >
            {t("activity.task_activity_title")}
          </span>
        </span>
        {compact && count > 0 ? (
          <span className="text-sm text-text-muted">
            {t("activity.task_activity_count", undefined, { count })}
          </span>
        ) : null}
        <span className="flex-1" />
        {compact ? (
          <span className="task-detail-activity-order flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary">
            <ArrowDownUp className="h-3.5 w-3.5" />
            {t("activity.task_activity_latest")}
          </span>
        ) : null}
        <div className="task-detail-activity-tools">{tools}</div>
      </header>
      <div
        ref={listRef}
        data-testid={listTestId}
        className={cn(
          rail && "min-h-0 flex-1 overflow-y-auto px-[18px] pb-4 pt-0.5",
          linear && "task-detail-comments-list",
          !compact && "min-h-48 py-3",
        )}
      >
        {error ? <p role="alert">{error}</p> : null}
        {loading ? (
          <div
            role="status"
            className="flex min-h-48 items-center justify-center text-sm text-text-muted"
          >
            <CompositedSpinner className="mr-2 h-4 w-4" />
            {t("activity.project_chat_loading")}
          </div>
        ) : count === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center text-center">
            <MessageSquareText className="h-8 w-8 text-text-muted" />
            <p className="mt-3 text-sm font-medium text-text-primary">
              {t("activity.task_activity_empty")}
            </p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-text-muted">
              {emptyDescription}
            </p>
          </div>
        ) : (
          children
        )}
      </div>
      <footer
        className={cn(
          rail &&
            "shrink-0 border-t border-border bg-background px-[18px] py-3",
          linear && "task-detail-comment-bar",
          !compact && "pt-2",
        )}
      >
        {composer}
      </footer>
    </section>
  );
}
