// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  CalendarClock,
  Pencil,
  Plus,
  Sparkles,
  Tag,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CollaborationTranslate } from "../i18n";
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationRule,
  WorkspaceIncomingHook,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
  CollaborationProject,
} from "../types";
import { ProjectSettingsPage } from "./ProjectSettingsPage";

type TriggerKind = "created" | "tag_added" | "external" | "schedule";
type TargetKind = "human" | "agent" | "collaboration_group";

const TRIGGER_OPTIONS = [
  {
    kind: "created",
    icon: Sparkles,
    title: ["Issue 创建后", "Issue created"],
    description: ["新 Issue 进入项目时", "When a new issue enters the project"],
  },
  {
    kind: "tag_added",
    icon: Tag,
    title: ["添加 Tag 后", "Tag added"],
    description: ["Issue 添加指定 Tag 时", "When a matching tag is added"],
  },
  {
    kind: "external",
    icon: Webhook,
    title: ["外部事件发生后", "External event"],
    description: ["收到已接入系统的事件时", "When a connected system fires"],
  },
  {
    kind: "schedule",
    icon: CalendarClock,
    title: ["定时处理", "Scheduled"],
    description: ["按指定时间周期触发", "Run on a configured schedule"],
  },
] as const satisfies ReadonlyArray<{
  kind: TriggerKind;
  icon: typeof Sparkles;
  title: readonly [string, string];
  description: readonly [string, string];
}>;

interface AutomaticProcessingDraft {
  id: string | null;
  version: number | null;
  name: string;
  trigger: TriggerKind;
  tag: string;
  cronExpression: string;
  hookId: string;
  eventType: string;
  targetKind: TargetKind;
  targetId: string;
  enabled: boolean;
}

const EMPTY_DRAFT: AutomaticProcessingDraft = {
  id: null,
  version: null,
  name: "",
  trigger: "created",
  tag: "",
  cronExpression: "0 9 * * 1-5",
  hookId: "",
  eventType: "",
  targetKind: "agent",
  targetId: "",
  enabled: true,
};

function AutomaticProcessingSwitch({
  checked,
  disabled,
  label,
  onChange,
  testId,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(checked: boolean): void;
  testId: string;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className="inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={`relative inline-flex h-5 w-8 items-center rounded-full transition-colors ${
          checked ? "bg-blue-500" : "bg-text-muted/30"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full border border-white bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[14px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function text(rule: Record<string, unknown>, camel: string, snake: string) {
  const value = rule[camel] ?? rule[snake];
  return typeof value === "string" ? value : "";
}

function bool(rule: WorkspaceAutomationRule, key: string, fallback: boolean) {
  return typeof rule[key] === "boolean" ? Boolean(rule[key]) : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sourceType(hook: WorkspaceIncomingHook) {
  return text(
    hook as unknown as Record<string, unknown>,
    "sourceType",
    "source_type",
  );
}

function eventTypesForHook(hook: WorkspaceIncomingHook): string[] {
  const source = sourceType(hook);
  if (source === "github") {
    return [
      "change_request.checks_failed",
      "change_request.merge_conflict",
      "change_request.review_submitted",
      "change_request.comment_created",
    ];
  }
  if (source === "gitlab") {
    return [
      "change_request.checks_failed",
      "change_request.merge_conflict",
      "change_request.comment_created",
    ];
  }
  return ["document.changed"];
}

function eventLabel(value: string, locale: "zh-CN" | "en") {
  const labels: Record<string, [string, string]> = {
    "change_request.checks_failed": ["代码检查失败", "Checks failed"],
    "change_request.merge_conflict": ["发生合并冲突", "Merge conflict"],
    "change_request.review_submitted": ["提交代码评审", "Review submitted"],
    "change_request.comment_created": ["新增代码评论", "Comment created"],
    "document.changed": ["外部文档变化", "External document changed"],
  };
  const label = labels[value];
  return label ? label[locale === "zh-CN" ? 0 : 1] : value;
}

function draftFromRule(
  rule: WorkspaceAutomationRule,
): AutomaticProcessingDraft {
  const values = rule as Record<string, unknown>;
  const triggerType = text(values, "triggerType", "trigger_type");
  const eventType = text(values, "eventType", "event_type");
  const eventConfig = record(rule.eventConfig ?? rule.event_config);
  const tags = Array.isArray(eventConfig.tags) ? eventConfig.tags : [];
  const trigger: TriggerKind =
    triggerType === "schedule"
      ? "schedule"
      : eventType === "task.tag_added"
        ? "tag_added"
        : eventType === "task.created"
          ? "created"
          : "external";
  return {
    id: rule.id,
    version: rule.version,
    name: rule.name,
    trigger,
    tag: typeof tags[0] === "string" ? tags[0] : "",
    cronExpression: text(values, "cronExpression", "cron_expression"),
    hookId: String(
      eventConfig.subscriptionId ?? eventConfig.subscription_id ?? "",
    ),
    eventType: trigger === "external" ? eventType : "",
    targetKind: (text(values, "targetKind", "target_kind") ||
      "agent") as TargetKind,
    targetId: text(values, "targetId", "target_id"),
    enabled: bool(rule, "enabled", true),
  };
}

export function ProjectAutomaticProcessing({
  api,
  project,
  members,
  agents,
  locale,
  translate,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  translate: CollaborationTranslate;
}) {
  const [rules, setRules] = useState<WorkspaceAutomationRule[]>([]);
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [hooks, setHooks] = useState<WorkspaceIncomingHook[]>([]);
  const [draft, setDraft] = useState<AutomaticProcessingDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canManage =
    project.access_role === "Owner" || project.access_role === "Maintainer";

  const load = useCallback(async () => {
    if (!api.automations) {
      setLoading(false);
      setError(
        translate(
          "todo.automatic_processing_unavailable",
          "当前项目暂不支持自动处理。",
        ),
      );
      return;
    }
    setLoading(true);
    setError("");
    try {
      const [nextRules, nextGroups, nextHooks] = await Promise.all([
        api.automations.list(project.id),
        api.projects.listCollaborationGroups?.(project.id) ?? [],
        api.incomingHooks?.list(project.id).catch(() => []) ?? [],
      ]);
      setRules(nextRules);
      setGroups(nextGroups);
      setHooks(nextHooks);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : translate(
              "todo.automatic_processing_load_failed",
              "加载自动处理失败",
            ),
      );
    } finally {
      setLoading(false);
    }
  }, [api, project.id, translate]);

  useEffect(() => {
    void load();
  }, [load]);

  const targetOptions = useMemo(
    () => ({
      human: members.map((member) => ({
        id: String(member.user_id),
        name: member.user_name,
      })),
      agent: agents.map((agent) => ({ id: agent.id, name: agent.name })),
      collaboration_group: groups.map((group) => ({
        id: group.id,
        name: group.name,
      })),
    }),
    [agents, groups, members],
  );
  const selectedHook = hooks.find((hook) => hook.id === draft.hookId) ?? null;
  const externalEventTypes = selectedHook
    ? eventTypesForHook(selectedHook)
    : [];
  const targetAvailable = targetOptions[draft.targetKind].some(
    (option) => option.id === draft.targetId,
  );
  const valid = Boolean(
    targetAvailable &&
    (draft.trigger !== "tag_added" || draft.tag.trim()) &&
    (draft.trigger !== "schedule" || draft.cronExpression.trim()) &&
    (draft.trigger !== "external" || (draft.hookId && draft.eventType)),
  );

  function updateDraft(patch: Partial<AutomaticProcessingDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function openCreate() {
    const firstAgent = targetOptions.agent[0];
    const firstHuman = targetOptions.human[0];
    const firstGroup = targetOptions.collaboration_group[0];
    const targetKind: TargetKind = firstAgent
      ? "agent"
      : firstHuman
        ? "human"
        : "collaboration_group";
    const target = firstAgent ??
      firstHuman ??
      firstGroup ?? { id: "", name: "" };
    setDraft({
      ...EMPTY_DRAFT,
      targetKind,
      targetId: target.id,
    });
    setEditing(true);
    setError("");
  }

  function selectTrigger(trigger: TriggerKind) {
    const hook = hooks[0];
    const eventType = hook ? (eventTypesForHook(hook)[0] ?? "") : "";
    updateDraft({
      trigger,
      ...(trigger === "external"
        ? {
            hookId: draft.hookId || hook?.id || "",
            eventType: draft.eventType || eventType,
          }
        : {}),
    });
  }

  function inputFromDraft(value: AutomaticProcessingDraft) {
    const isSchedule = value.trigger === "schedule";
    const eventType =
      value.trigger === "created"
        ? "task.created"
        : value.trigger === "tag_added"
          ? "task.tag_added"
          : value.trigger === "external"
            ? value.eventType
            : null;
    const eventConfig =
      value.trigger === "tag_added"
        ? { executionTarget: "existing_issue", tags: [value.tag.trim()] }
        : value.trigger === "external"
          ? {
              executionTarget: "create_issue",
              subscriptionId: value.hookId,
            }
          : { executionTarget: "existing_issue" };
    const targetName =
      targetOptions[value.targetKind].find(
        (option) => option.id === value.targetId,
      )?.name ?? translate("todo.unavailable_target", "目标不可用");
    const triggerName =
      value.trigger === "created"
        ? translate("todo.trigger_issue_created", "Issue 创建后")
        : value.trigger === "tag_added"
          ? `${translate("todo.trigger_tag_added", "添加 Tag 后")} · ${value.tag}`
          : value.trigger === "schedule"
            ? translate("todo.trigger_schedule", "按时间定期处理")
            : eventLabel(value.eventType, locale);
    return {
      name: value.name.trim() || `${triggerName} → ${targetName}`,
      prompt: translate(
        "todo.automatic_processing_default_instruction",
        "按照目标职责和 Issue 内容完成处理，并记录清晰的执行结果。",
      ),
      triggerType: isSchedule ? "schedule" : "event",
      eventType,
      eventConfig,
      cronExpression: isSchedule ? value.cronExpression.trim() : null,
      timezone: "Asia/Shanghai",
      targetKind: value.targetKind,
      targetId: value.targetId,
      assignmentMode: "manual",
      managerType: null,
      agentId: value.targetKind === "agent" ? value.targetId : null,
      wegentTeamId: null,
      model: null,
      executionEnvironment: null,
      executionDeviceId: null,
      roleSource: value.targetKind === "agent" ? "agent" : "generic",
      runtimeSource:
        value.targetKind === "agent" ? "agent_default" : "runtime_user",
      runtimeProfileId: null,
      runtimeUserId:
        value.targetKind === "human" ? Number(value.targetId) : null,
      enabled: value.enabled,
    };
  }

  async function save() {
    if (!valid || !api.automations) return;
    setSaving(true);
    setError("");
    const input = inputFromDraft(draft);
    try {
      if (draft.id && draft.version) {
        await api.automations.update(project.id, draft.id, {
          ...input,
          version: draft.version,
        });
      } else {
        await api.automations.create(project.id, input);
      }
      setEditing(false);
      setDraft(EMPTY_DRAFT);
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : translate(
              "todo.automatic_processing_save_failed",
              "保存自动处理失败",
            ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: WorkspaceAutomationRule) {
    if (!api.automations) return;
    const ruleDraft = draftFromRule(rule);
    setSaving(true);
    setError("");
    try {
      await api.automations.update(project.id, rule.id, {
        ...inputFromDraft({ ...ruleDraft, enabled: !ruleDraft.enabled }),
        version: rule.version,
      });
      await load();
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : translate(
              "todo.automatic_processing_save_failed",
              "保存自动处理失败",
            ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function remove(rule: WorkspaceAutomationRule) {
    if (!api.automations) return;
    setSaving(true);
    setError("");
    try {
      await api.automations.remove(project.id, rule.id);
      if (draft.id === rule.id) {
        setEditing(false);
        setDraft(EMPTY_DRAFT);
      }
      await load();
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : translate(
              "todo.automatic_processing_delete_failed",
              "删除自动处理失败",
            ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <ProjectSettingsPage
      actions={
        canManage ? (
          <button
            type="button"
            className="collaboration-primary-button inline-flex shrink-0 items-center gap-1.5"
            data-testid="automatic-processing-create"
            onClick={openCreate}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {translate("todo.create_automatic_processing", "新建规则")}
          </button>
        ) : undefined
      }
      description={translate(
        "todo.automatic_processing_description",
        "当 Issue 满足指定条件时，自动交给项目成员、智能体或协作小组。",
      )}
      testId="collaboration-project-automatic-processing-page"
      title={translate("todo.automatic_processing", "自动处理")}
    >
      <div className="space-y-4" data-testid="automatic-processing">
        {loading ? (
          <p
            className="py-8 text-center text-sm text-text-muted"
            data-testid="automatic-processing-loading"
          >
            {translate("common.loading", "加载中…")}
          </p>
        ) : (
          <>
            {error ? (
              <div className="collaboration-alert" role="alert">
                {error}
              </div>
            ) : null}

            {rules.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/70">
                {rules.map((rule) => {
                  const ruleDraft = draftFromRule(rule);
                  const triggerLabel =
                    ruleDraft.trigger === "created"
                      ? translate("todo.trigger_issue_created", "Issue 创建后")
                      : ruleDraft.trigger === "tag_added"
                        ? `${translate("todo.trigger_tag_added", "添加 Tag 后")} · ${ruleDraft.tag}`
                        : ruleDraft.trigger === "schedule"
                          ? `${translate("todo.trigger_schedule", "按时间定期处理")} · ${ruleDraft.cronExpression}`
                          : eventLabel(ruleDraft.eventType, locale);
                  const targetName =
                    text(
                      rule as Record<string, unknown>,
                      "targetName",
                      "target_name",
                    ) ||
                    targetOptions[ruleDraft.targetKind].find(
                      (option) => option.id === ruleDraft.targetId,
                    )?.name ||
                    translate("todo.unavailable_target", "目标不可用");
                  return (
                    <article
                      className="flex min-h-14 items-center gap-4 px-4 py-3"
                      data-testid={`automatic-processing-rule-${rule.id}`}
                      key={rule.id}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setDraft(ruleDraft);
                          setEditing(true);
                          setError("");
                        }}
                        type="button"
                      >
                        <strong className="block truncate text-sm font-medium text-text-primary">
                          {rule.name}
                        </strong>
                        <span className="mt-0.5 block truncate text-xs text-text-secondary">
                          {triggerLabel} → {targetName}
                        </span>
                      </button>
                      {canManage ? (
                        <div className="flex shrink-0 items-center gap-1">
                          <AutomaticProcessingSwitch
                            checked={ruleDraft.enabled}
                            disabled={saving}
                            label={translate("todo.enable_rule", "启用规则")}
                            onChange={() => void toggle(rule)}
                            testId={`automatic-processing-enabled-${rule.id}`}
                          />
                          <button
                            aria-label={translate("common.edit", "编辑")}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted"
                            data-testid={`automatic-processing-edit-${rule.id}`}
                            onClick={() => {
                              setDraft(ruleDraft);
                              setEditing(true);
                              setError("");
                            }}
                            type="button"
                          >
                            <Pencil aria-hidden="true" className="h-4 w-4" />
                          </button>
                          <button
                            aria-label={translate("common.delete", "删除")}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                            data-testid={`automatic-processing-delete-${rule.id}`}
                            disabled={saving}
                            onClick={() => void remove(rule)}
                            type="button"
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : !editing && !error ? (
              <div className="py-12 text-center text-sm text-text-secondary">
                {translate("todo.no_automatic_processing", "暂无自动处理规则")}
              </div>
            ) : null}
          </>
        )}
      </div>

      {editing ? (
        <div className="collaboration-dialog-backdrop !bg-black/20">
          <form
            aria-labelledby="automatic-processing-dialog-title"
            aria-modal="true"
            className="collaboration-dialog flex max-h-[calc(100vh-48px)] w-full max-w-[680px] flex-col overflow-hidden !rounded-2xl !p-0 !shadow-lg"
            data-testid="automatic-processing-form"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !saving) {
                setEditing(false);
                setDraft(EMPTY_DRAFT);
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            role="dialog"
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <h2
                className="heading-small !m-0"
                id="automatic-processing-dialog-title"
              >
                {draft.id
                  ? translate("todo.edit_automatic_processing", "编辑自动处理")
                  : translate(
                      "todo.create_automatic_processing",
                      "新建自动处理",
                    )}
              </h2>
              <button
                aria-label={translate("common.close", "关闭")}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(EMPTY_DRAFT);
                }}
                type="button"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
              <p className="text-sm text-text-secondary">
                {translate(
                  "todo.automatic_processing_editor_description",
                  "选择触发条件和处理对象，规则名称会自动生成。",
                )}
              </p>

              <fieldset
                className="grid grid-cols-2 gap-2"
                data-testid="automatic-processing-trigger"
              >
                <legend className="mb-2 text-sm font-medium text-text-primary">
                  {translate("todo.when", "触发条件")}
                </legend>
                {TRIGGER_OPTIONS.map((option, index) => {
                  const selected = draft.trigger === option.kind;
                  const Icon = option.icon;
                  const localeIndex = locale === "zh-CN" ? 0 : 1;
                  return (
                    <label
                      className={`flex min-h-[68px] cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${
                        selected
                          ? "border-focus bg-focus/5"
                          : "border-border hover:bg-muted/60"
                      }`}
                      key={option.kind}
                    >
                      <input
                        autoFocus={index === 0}
                        checked={selected}
                        className="sr-only"
                        data-testid={`automatic-processing-trigger-${option.kind}`}
                        name="automatic-processing-trigger"
                        onChange={() => selectTrigger(option.kind)}
                        type="radio"
                        value={option.kind}
                      />
                      <Icon
                        aria-hidden="true"
                        className={`mt-0.5 h-4 w-4 shrink-0 ${
                          selected ? "text-focus" : "text-text-secondary"
                        }`}
                      />
                      <span className="min-w-0">
                        <strong className="block text-sm font-medium text-text-primary">
                          {option.title[localeIndex]}
                        </strong>
                        <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                          {option.description[localeIndex]}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border px-4">
                {draft.trigger === "tag_added" ? (
                  <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                    <label
                      className="w-14 shrink-0 font-medium text-text-primary"
                      htmlFor="automatic-processing-tag"
                    >
                      {translate("todo.matching_tag", "Tag")}
                    </label>
                    <input
                      className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 outline-none focus:border-focus"
                      data-testid="automatic-processing-tag"
                      id="automatic-processing-tag"
                      value={draft.tag}
                      onChange={(event) =>
                        updateDraft({ tag: event.target.value })
                      }
                    />
                  </div>
                ) : null}

                {draft.trigger === "schedule" ? (
                  <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                    <label
                      className="w-14 shrink-0 font-medium text-text-primary"
                      htmlFor="automatic-processing-cron"
                    >
                      {translate("todo.schedule_expression", "时间")}
                    </label>
                    <input
                      className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 font-mono outline-none focus:border-focus"
                      data-testid="automatic-processing-cron"
                      id="automatic-processing-cron"
                      value={draft.cronExpression}
                      onChange={(event) =>
                        updateDraft({ cronExpression: event.target.value })
                      }
                    />
                  </div>
                ) : null}

                {draft.trigger === "external" ? (
                  <>
                    <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                      <label
                        className="w-14 shrink-0 font-medium text-text-primary"
                        htmlFor="automatic-processing-hook"
                      >
                        {translate("todo.event_source", "来源")}
                      </label>
                      <select
                        className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3"
                        data-testid="automatic-processing-hook"
                        id="automatic-processing-hook"
                        value={draft.hookId}
                        onChange={(event) => {
                          const hook = hooks.find(
                            (candidate) => candidate.id === event.target.value,
                          );
                          updateDraft({
                            hookId: event.target.value,
                            eventType: hook
                              ? (eventTypesForHook(hook)[0] ?? "")
                              : "",
                          });
                        }}
                      >
                        <option value="">
                          {translate("common.select", "请选择")}
                        </option>
                        {hooks.map((hook) => (
                          <option key={hook.id} value={hook.id}>
                            {hook.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                      <label
                        className="w-14 shrink-0 font-medium text-text-primary"
                        htmlFor="automatic-processing-event"
                      >
                        {translate("todo.event_type", "事件")}
                      </label>
                      <select
                        className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3"
                        data-testid="automatic-processing-event"
                        id="automatic-processing-event"
                        value={draft.eventType}
                        onChange={(event) =>
                          updateDraft({ eventType: event.target.value })
                        }
                      >
                        <option value="">
                          {translate("common.select", "请选择")}
                        </option>
                        {externalEventTypes.map((eventType) => (
                          <option key={eventType} value={eventType}>
                            {eventLabel(eventType, locale)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : null}

                <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                  <label
                    className="w-14 shrink-0 font-medium text-text-primary"
                    htmlFor="automatic-processing-target"
                  >
                    {translate("todo.assign_to", "交给")}
                  </label>
                  <select
                    className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-3"
                    data-testid="automatic-processing-target"
                    id="automatic-processing-target"
                    value={
                      draft.targetId
                        ? `${draft.targetKind}:${draft.targetId}`
                        : ""
                    }
                    onChange={(event) => {
                      const separator = event.target.value.indexOf(":");
                      if (separator < 0) {
                        updateDraft({ targetId: "" });
                        return;
                      }
                      updateDraft({
                        targetKind: event.target.value.slice(
                          0,
                          separator,
                        ) as TargetKind,
                        targetId: event.target.value.slice(separator + 1),
                      });
                    }}
                  >
                    <option value="">
                      {translate("common.select", "请选择")}
                    </option>
                    <optgroup label={translate("todo.target_agent", "智能体")}>
                      {targetOptions.agent.map((option) => (
                        <option
                          key={`agent:${option.id}`}
                          value={`agent:${option.id}`}
                        >
                          {option.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup
                      label={translate("todo.project_members", "项目成员")}
                    >
                      {targetOptions.human.map((option) => (
                        <option
                          key={`human:${option.id}`}
                          value={`human:${option.id}`}
                        >
                          {option.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup
                      label={translate(
                        "todo.target_collaboration_group",
                        "协作小组",
                      )}
                    >
                      {targetOptions.collaboration_group.map((option) => (
                        <option
                          key={`collaboration_group:${option.id}`}
                          value={`collaboration_group:${option.id}`}
                        >
                          {option.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                <div className="flex min-h-12 items-center gap-4 py-2 text-sm">
                  <span className="w-14 shrink-0 font-medium text-text-primary">
                    {translate("todo.rule_status", "启用")}
                  </span>
                  <span className="min-w-0 flex-1 text-xs text-text-secondary">
                    {translate(
                      "todo.automatic_processing_runner_hint",
                      "运行时自动选择项目中的可用设备",
                    )}
                  </span>
                  <AutomaticProcessingSwitch
                    checked={draft.enabled}
                    label={translate("todo.enable_rule", "启用规则")}
                    onChange={(enabled) => updateDraft({ enabled })}
                    testId="automatic-processing-enabled"
                  />
                </div>
              </div>

              {error ? (
                <div className="collaboration-alert" role="alert">
                  {error}
                </div>
              ) : null}
            </div>

            <footer className="flex h-14 shrink-0 items-center justify-end gap-2 border-t border-border px-5">
              <button
                className="h-8 rounded-lg border border-border px-3 text-sm text-text-secondary hover:bg-muted"
                data-testid="automatic-processing-cancel"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setDraft(EMPTY_DRAFT);
                }}
                type="button"
              >
                {translate("common.cancel", "取消")}
              </button>
              <button
                className="collaboration-primary-button"
                data-testid="automatic-processing-save"
                disabled={!valid || saving}
                type="submit"
              >
                {saving
                  ? translate("common.saving", "保存中…")
                  : draft.id
                    ? translate("common.save", "保存")
                    : translate("todo.create_rule", "创建规则")}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </ProjectSettingsPage>
  );
}
