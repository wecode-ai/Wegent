// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { X } from "lucide-react";
import type { WorkspaceProjectManagerTrigger } from "../ports/SharedWorkspaceApi";

const eventOptions = [
  ["task.created", "Issue 创建", "Issue created"],
  ["task.tag_added", "添加 Tag", "Tag added"],
  ["task.status_changed", "Issue 状态变化", "Issue status changed"],
] as const;

export function projectManagerTriggerLabel(
  trigger: WorkspaceProjectManagerTrigger,
  locale: "zh-CN" | "en",
) {
  if (trigger.kind === "schedule") {
    return locale === "zh-CN"
      ? `定时 · ${trigger.cronExpression ?? ""}`
      : `Schedule · ${trigger.cronExpression ?? ""}`;
  }
  const event = eventOptions.find(([value]) => value === trigger.eventType);
  const label = event?.[locale === "zh-CN" ? 1 : 2] ?? trigger.eventType;
  return trigger.tags.length ? `${label} · ${trigger.tags.join(", ")}` : label;
}

export function ProjectManagerTriggerEditor({
  trigger,
  locale,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  trigger: WorkspaceProjectManagerTrigger;
  locale: "zh-CN" | "en";
  saving: boolean;
  onChange(trigger: WorkspaceProjectManagerTrigger): void;
  onClose(): void;
  onSave(): void;
}) {
  const zh = locale === "zh-CN";
  return (
    <div className="collaboration-dialog-backdrop !bg-black/20">
      <form
        aria-modal="true"
        className="collaboration-dialog flex max-h-[calc(100vh-48px)] w-full max-w-[520px] flex-col gap-5 overflow-y-auto !rounded-2xl !p-6 !shadow-lg"
        data-testid="project-ai-trigger-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="heading-sm">
              {zh ? "项目管理者触发条件" : "Project manager trigger"}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {zh
                ? "满足条件时，项目管理者会在项目执行器中运行。"
                : "Run the project manager in the project executor when this condition is met."}
            </p>
          </div>
          <button
            aria-label={zh ? "关闭" : "Close"}
            className="rounded-lg p-1 text-text-secondary hover:bg-muted"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <label className="space-y-2 text-sm text-text-primary">
          <span className="block font-medium">
            {zh ? "触发方式" : "Trigger type"}
          </span>
          <select
            className="w-full rounded-lg border border-border bg-background px-3 py-2"
            data-testid={`project-ai-trigger-kind-${trigger.id}`}
            value={trigger.kind}
            onChange={(event) =>
              onChange({
                ...trigger,
                kind: event.target.value as "event" | "schedule",
                eventType:
                  event.target.value === "event" ? "task.created" : null,
                cronExpression:
                  event.target.value === "schedule" ? "0 9 * * *" : null,
              })
            }
          >
            <option value="event">{zh ? "事件" : "Event"}</option>
            <option value="schedule">{zh ? "定时" : "Schedule"}</option>
          </select>
        </label>
        {trigger.kind === "event" ? (
          <>
            <label className="space-y-2 text-sm text-text-primary">
              <span className="block font-medium">
                {zh ? "发生事件" : "Event"}
              </span>
              <select
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                data-testid={`project-ai-trigger-event-${trigger.id}`}
                value={trigger.eventType ?? "task.created"}
                onChange={(event) =>
                  onChange({
                    ...trigger,
                    eventType: event.target
                      .value as WorkspaceProjectManagerTrigger["eventType"],
                  })
                }
              >
                {eventOptions.map(([value, chinese, english]) => (
                  <option key={value} value={value}>
                    {zh ? chinese : english}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm text-text-primary">
              <span className="block font-medium">
                {zh ? "Tag 筛选（可选）" : "Tag filter (optional)"}
              </span>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                data-testid={`project-ai-trigger-tags-${trigger.id}`}
                placeholder={
                  zh ? "多个 Tag 用逗号分隔" : "Separate tags with commas"
                }
                defaultValue={trigger.tags.join(", ")}
                onBlur={(event) =>
                  onChange({
                    ...trigger,
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </>
        ) : (
          <>
            <label className="space-y-2 text-sm text-text-primary">
              <span className="block font-medium">
                {zh ? "Cron 表达式" : "Cron expression"}
              </span>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                data-testid={`project-ai-trigger-cron-${trigger.id}`}
                value={trigger.cronExpression ?? ""}
                onChange={(event) =>
                  onChange({ ...trigger, cronExpression: event.target.value })
                }
              />
            </label>
            <label className="space-y-2 text-sm text-text-primary">
              <span className="block font-medium">
                {zh ? "时区" : "Timezone"}
              </span>
              <input
                className="w-full rounded-lg border border-border bg-background px-3 py-2"
                data-testid={`project-ai-trigger-timezone-${trigger.id}`}
                value={trigger.timezone}
                onChange={(event) =>
                  onChange({ ...trigger, timezone: event.target.value })
                }
              />
            </label>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            checked={trigger.enabled}
            data-testid={`project-ai-trigger-enabled-${trigger.id}`}
            type="checkbox"
            onChange={(event) =>
              onChange({ ...trigger, enabled: event.target.checked })
            }
          />
          {zh ? "启用此条件" : "Enable this condition"}
        </label>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <button
            className="rounded-lg px-4 py-2 text-text-secondary hover:bg-muted"
            onClick={onClose}
            type="button"
          >
            {zh ? "取消" : "Cancel"}
          </button>
          <button
            className="collaboration-primary-button"
            data-testid="project-ai-save"
            disabled={saving}
            type="submit"
          >
            {saving
              ? zh
                ? "保存中…"
                : "Saving…"
              : zh
                ? "保存规则"
                : "Save rule"}
          </button>
        </div>
      </form>
    </div>
  );
}
