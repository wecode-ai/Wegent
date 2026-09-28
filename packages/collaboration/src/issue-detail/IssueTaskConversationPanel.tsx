import type { ReactNode } from "react";
import { ArrowUpRight, Monitor } from "lucide-react";
import type { CollaborationTranslate } from "../i18n";
import { IssueDrawerHeader } from "./IssueDrawerHeader";
import { activityClassNames as cn } from "./activityClassNames";

/** PC sidebar surface, shared by existing conversations and new task composers. */
export function IssueTaskConversationPanel({
  issueId,
  taskTitle,
  executionDeviceName,
  open = true,
  existingTask,
  onClose,
  onBack,
  onOpenTask,
  translate: t,
  children,
}: {
  issueId?: string;
  taskTitle?: string | null;
  executionDeviceName?: string | null;
  open?: boolean;
  existingTask: boolean;
  onClose(): void;
  onBack?(): void;
  onOpenTask?(): void | Promise<void>;
  translate: CollaborationTranslate;
  children: ReactNode;
}) {
  return (
    <aside
      data-testid="ai-chat-modal-backdrop"
      data-presentation="sidebar"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "task-conversation-workspace-panel relative z-10 flex h-full min-h-0 shrink-0 flex-col rounded-2xl bg-background",
        !open && "hidden",
      )}
    >
      <section
        data-testid="ai-chat-modal"
        className="todo-floating-panel-surface flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      >
        <IssueDrawerHeader
          title={
            <>
              <b className="font-medium text-text-secondary">{issueId}</b>
              {taskTitle ? (
                <>
                  {" · "}
                  <span data-testid="issue-task-conversation-title">
                    {taskTitle}
                  </span>
                </>
              ) : (
                <>
                  {" · "}
                  {existingTask
                    ? t("workbench.task_conversation", "任务对话")
                    : t("todo.new_task")}
                </>
              )}
            </>
          }
          onBack={onBack ?? onClose}
          onClose={onClose}
          backLabel={t("workbench.back_to_work_item", "返回 Issue")}
          closeLabel={t("common.close", "关闭")}
          actions={
            <>
              {executionDeviceName ? (
                <span
                  data-testid="ai-chat-execution-device"
                  title={
                    t("workbench.task_activity_execution_device", "执行设备") +
                    ": " +
                    executionDeviceName
                  }
                  className="flex h-7 max-w-[160px] shrink-0 items-center gap-1 rounded-lg px-1.5 text-xs text-text-muted"
                >
                  <Monitor className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{executionDeviceName}</span>
                </span>
              ) : null}
              {existingTask && onOpenTask ? (
                <button
                  type="button"
                  data-testid="ai-chat-open-runtime-task"
                  onClick={() => void onOpenTask()}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-text-secondary transition hover:bg-muted hover:text-text-primary"
                >
                  {t("workbench.open_full_task", "打开完整任务")}
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </>
          }
        />
        {children}
      </section>
    </aside>
  );
}
