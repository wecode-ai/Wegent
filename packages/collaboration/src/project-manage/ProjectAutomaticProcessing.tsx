// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
  UsersRound,
  Webhook,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CollaborationTranslate } from "../i18n";
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationRule,
  WorkspaceIncomingHook,
  WorkspaceProjectManagerTrigger,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
  CollaborationProject,
} from "../types";
import { useAutomaticProcessingRules } from "./useAutomaticProcessingRules";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import {
  ProjectManagerTriggerEditor,
  projectManagerTriggerLabel,
} from "./ProjectManagerTriggerEditor";
import { useProjectManagerAutomation } from "./useProjectManagerAutomation";

type TriggerKind = "created" | "tag_added" | "external" | "schedule";
type TargetKind = "human" | "agent" | "collaboration_group";
type ScheduleFrequency = "daily" | "weekdays" | "weekly" | "custom";

interface ScheduleValue {
  frequency: ScheduleFrequency;
  time: string;
  weekday: string;
}

const WEEKDAY_OPTIONS = [
  ["1", "周一", "Monday"],
  ["2", "周二", "Tuesday"],
  ["3", "周三", "Wednesday"],
  ["4", "周四", "Thursday"],
  ["5", "周五", "Friday"],
  ["6", "周六", "Saturday"],
  ["0", "周日", "Sunday"],
] as const;

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

function parseSchedule(cronExpression: string): ScheduleValue {
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = cronExpression
    .trim()
    .split(/\s+/);
  const minuteNumber = Number(minute);
  const hourNumber = Number(hour);
  const validTime =
    Number.isInteger(minuteNumber) &&
    minuteNumber >= 0 &&
    minuteNumber <= 59 &&
    Number.isInteger(hourNumber) &&
    hourNumber >= 0 &&
    hourNumber <= 23;
  const time = validTime
    ? `${String(hourNumber).padStart(2, "0")}:${String(minuteNumber).padStart(2, "0")}`
    : "09:00";

  if (rest.length || !validTime || dayOfMonth !== "*" || month !== "*") {
    return { frequency: "custom", time, weekday: "1" };
  }
  if (dayOfWeek === "*") {
    return { frequency: "daily", time, weekday: "1" };
  }
  if (dayOfWeek === "1-5") {
    return { frequency: "weekdays", time, weekday: "1" };
  }
  if (WEEKDAY_OPTIONS.some(([value]) => value === dayOfWeek)) {
    return { frequency: "weekly", time, weekday: dayOfWeek };
  }
  return { frequency: "custom", time, weekday: "1" };
}

function buildScheduleCron({
  frequency,
  time,
  weekday,
}: ScheduleValue): string {
  const [hour = "09", minute = "00"] = time.split(":");
  const dayOfWeek =
    frequency === "daily" ? "*" : frequency === "weekdays" ? "1-5" : weekday;
  return `${Number(minute)} ${Number(hour)} * * ${dayOfWeek}`;
}

function scheduleLabel(cronExpression: string, locale: "zh-CN" | "en"): string {
  const schedule = parseSchedule(cronExpression);
  if (schedule.frequency === "custom") {
    return locale === "zh-CN"
      ? `自定义时间 · ${cronExpression.trim()}`
      : `Custom schedule · ${cronExpression.trim()}`;
  }
  const time = schedule.time;
  if (schedule.frequency === "daily") {
    return locale === "zh-CN" ? `每天 ${time}` : `Every day at ${time}`;
  }
  if (schedule.frequency === "weekdays") {
    return locale === "zh-CN" ? `工作日 ${time}` : `Weekdays at ${time}`;
  }
  const weekday =
    WEEKDAY_OPTIONS.find(([value]) => value === schedule.weekday) ??
    WEEKDAY_OPTIONS[0];
  return locale === "zh-CN"
    ? `每${weekday[1]} ${time}`
    : `Every ${weekday[2]} at ${time}`;
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
  const {
    rules,
    loading,
    error: rulesError,
    load,
  } = useAutomaticProcessingRules(api.automations, project.id);
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [availableAgents, setAvailableAgents] =
    useState<CollaborationAgent[]>(agents);
  const [hooks, setHooks] = useState<WorkspaceIncomingHook[]>([]);
  const [draft, setDraft] = useState<AutomaticProcessingDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [targetPickerOpen, setTargetPickerOpen] = useState(false);
  const [targetQuery, setTargetQuery] = useState("");
  const [hooksLoading, setHooksLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [hooksError, setHooksError] = useState("");
  const managerAutomation = useProjectManagerAutomation(
    api.projectManager,
    project.id,
  );
  const [managerDraft, setManagerDraft] =
    useState<WorkspaceProjectManagerTrigger | null>(null);
  const translateRef = useRef(translate);
  translateRef.current = translate;
  const needsHooks = editing && draft.trigger === "external";
  const error =
    actionError ||
    managerAutomation.error ||
    optionsError ||
    (needsHooks && hooksError) ||
    (rulesError
      ? rulesError instanceof Error
        ? rulesError.message
        : translate("todo.automatic_processing_load_failed", "加载自动处理失败")
      : !api.automations
        ? translate(
            "todo.automatic_processing_unavailable",
            "当前项目暂不支持自动处理。",
          )
        : "");
  const canManage =
    project.access_role === "Owner" || project.access_role === "Maintainer";

  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setEditing(false);
    setManagerDraft(null);
    setHooks([]);
    setHooksError("");
    setError("");
  }, [api, project.id]);

  useEffect(() => {
    let active = true;
    setGroups([]);
    setOptionsError("");
    void Promise.all([
      api.projects.listCollaborationGroups?.(project.id) ?? [],
      api.agents.list(project.id),
    ])
      .then(([nextGroups, nextAgents]) => {
        if (!active) return;
        setGroups(nextGroups);
        setAvailableAgents(nextAgents);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setOptionsError(
          cause instanceof Error
            ? cause.message
            : translateRef.current(
                "todo.automatic_processing_load_failed",
                "加载自动处理失败",
              ),
        );
      });
    return () => {
      active = false;
    };
  }, [api, project.id]);

  useEffect(() => {
    if (!needsHooks || !api.incomingHooks) {
      setHooksLoading(false);
      return;
    }
    let active = true;
    setHooksLoading(true);
    setHooksError("");
    void api.incomingHooks
      .list(project.id)
      .then((nextHooks) => {
        if (!active) return;
        setHooks(nextHooks);
        const hook = nextHooks[0];
        if (hook)
          setDraft((current) =>
            current.hookId
              ? current
              : {
                  ...current,
                  hookId: hook.id,
                  eventType: eventTypesForHook(hook)[0] ?? "",
                },
          );
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setHooksError(
          cause instanceof Error
            ? cause.message
            : translateRef.current(
                "todo.automatic_processing_load_failed",
                "加载自动处理失败",
              ),
        );
      })
      .finally(() => {
        if (active) setHooksLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api.incomingHooks, project.id, needsHooks]);

  useEffect(() => {
    setAvailableAgents(agents);
  }, [agents]);

  const targetOptions = useMemo(
    () => ({
      human: members.map((member) => ({
        id: String(member.user_id),
        name: member.user_name,
      })),
      agent: availableAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
      })),
      collaboration_group: groups.map((group) => ({
        id: group.id,
        name: group.name,
      })),
    }),
    [availableAgents, groups, members],
  );
  const selectedHook = hooks.find((hook) => hook.id === draft.hookId) ?? null;
  const externalEventTypes = selectedHook
    ? eventTypesForHook(selectedHook)
    : [];
  const targetAvailable = targetOptions[draft.targetKind].some(
    (option) => option.id === draft.targetId,
  );
  const targetKindLabel = {
    agent: translate("todo.target_agent", "智能体"),
    human: translate("todo.project_members", "项目成员"),
    collaboration_group: translate(
      "todo.target_collaboration_group",
      "协作小组",
    ),
  } satisfies Record<TargetKind, string>;
  const selectedTargetName =
    targetOptions[draft.targetKind].find(
      (option) => option.id === draft.targetId,
    )?.name ?? translate("common.select", "请选择");
  const normalizedTargetQuery = targetQuery.trim().toLocaleLowerCase();
  const filteredTargets = targetOptions[draft.targetKind].filter((option) =>
    option.name.toLocaleLowerCase().includes(normalizedTargetQuery),
  );
  const targetKinds = [
    {
      kind: "human",
      label: targetKindLabel.human,
      icon: UserRound,
      options: targetOptions.human,
    },
    {
      kind: "agent",
      label: targetKindLabel.agent,
      icon: Bot,
      options: targetOptions.agent,
    },
    {
      kind: "collaboration_group",
      label: targetKindLabel.collaboration_group,
      icon: UsersRound,
      options: targetOptions.collaboration_group,
    },
  ] as const;
  const SelectedTargetIcon =
    draft.targetKind === "agent"
      ? Bot
      : draft.targetKind === "human"
        ? UserRound
        : UsersRound;
  const schedule = parseSchedule(draft.cronExpression);
  const triggerPreview =
    draft.trigger === "created"
      ? translate("todo.trigger_issue_created", "Issue 创建后")
      : draft.trigger === "tag_added"
        ? draft.tag.trim()
          ? `${translate("todo.trigger_tag_added", "添加 Tag 后")} · ${draft.tag.trim()}`
          : translate("todo.trigger_tag_added", "添加指定 Tag 后")
        : draft.trigger === "schedule"
          ? draft.cronExpression.trim()
            ? `${translate("todo.trigger_schedule", "按时间定期处理")} · ${scheduleLabel(draft.cronExpression, locale)}`
            : translate("todo.trigger_schedule", "按时间定期处理")
          : draft.eventType
            ? eventLabel(draft.eventType, locale)
            : translate("todo.trigger_external_event", "外部事件发生后");
  const valid = Boolean(
    targetAvailable &&
    (draft.trigger !== "external" || (!hooksLoading && !hooksError)) &&
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
    setTargetPickerOpen(false);
    setTargetQuery("");
    setEditing(true);
    setError("");
  }

  function openManagerCreate() {
    setManagerDraft({
      id: crypto.randomUUID(),
      kind: "event",
      eventType: "task.created",
      tags: [],
      timezone: "Asia/Shanghai",
      enabled: true,
    });
  }

  async function saveManagerDraft() {
    if (!managerDraft || !managerAutomation.config) return;
    const existing = managerAutomation.config.triggers.some(
      (item) => item.id === managerDraft.id,
    );
    const triggers = existing
      ? managerAutomation.config.triggers.map((item) =>
          item.id === managerDraft.id ? managerDraft : item,
        )
      : [...managerAutomation.config.triggers, managerDraft];
    if (await managerAutomation.saveTriggers(triggers)) setManagerDraft(null);
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
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="collaboration-primary-button inline-flex shrink-0 items-center gap-1.5"
              data-testid="automatic-processing-create"
              onClick={openCreate}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {translate("todo.create_automatic_processing", "新建规则")}
            </button>
            {api.projectManager && (
              <button
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary hover:bg-muted"
                data-testid="project-ai-add-trigger"
                disabled={
                  !managerAutomation.config || managerAutomation.loading
                }
                onClick={openManagerCreate}
                type="button"
              >
                {locale === "zh-CN"
                  ? "项目管理者触发"
                  : "Project manager trigger"}
              </button>
            )}
          </div>
        ) : undefined
      }
      description={translate(
        "todo.automatic_processing_description",
        "统一管理 Issue 自动处理和项目管理者的触发规则。",
      )}
      testId="collaboration-project-automatic-processing-page"
      title={translate("todo.automatic_processing", "自动处理")}
    >
      <div className="space-y-4" data-testid="automatic-processing">
        {loading || managerAutomation.loading ? (
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

            {rules.length || managerAutomation.config?.triggers.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background">
                {rules.map((rule) => {
                  const ruleDraft = draftFromRule(rule);
                  const triggerLabel =
                    ruleDraft.trigger === "created"
                      ? translate("todo.trigger_issue_created", "Issue 创建后")
                      : ruleDraft.trigger === "tag_added"
                        ? `${translate("todo.trigger_tag_added", "添加 Tag 后")} · ${ruleDraft.tag}`
                        : ruleDraft.trigger === "schedule"
                          ? `${translate("todo.trigger_schedule", "按时间定期处理")} · ${scheduleLabel(ruleDraft.cronExpression, locale)}`
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
                {managerAutomation.config?.triggers.map((trigger) => (
                  <article
                    className="flex min-h-14 items-center gap-4 px-4 py-3"
                    data-testid={`project-ai-trigger-${trigger.id}`}
                    key={trigger.id}
                  >
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setManagerDraft(trigger)}
                      type="button"
                    >
                      <strong className="block truncate text-sm font-medium text-text-primary">
                        {locale === "zh-CN" ? "项目管理者" : "Project manager"}
                      </strong>
                      <span className="mt-0.5 block truncate text-xs text-text-secondary">
                        {projectManagerTriggerLabel(trigger, locale)} →{" "}
                        {locale === "zh-CN"
                          ? "项目管理者 AI"
                          : "Project manager AI"}
                      </span>
                    </button>
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-1">
                        <AutomaticProcessingSwitch
                          checked={trigger.enabled}
                          disabled={managerAutomation.saving}
                          label={translate("todo.enable_rule", "启用规则")}
                          onChange={() =>
                            void managerAutomation.saveTriggers(
                              managerAutomation.config!.triggers.map((item) =>
                                item.id === trigger.id
                                  ? { ...item, enabled: !item.enabled }
                                  : item,
                              ),
                            )
                          }
                          testId={`project-ai-trigger-row-enabled-${trigger.id}`}
                        />
                        <button
                          aria-label={translate("common.edit", "编辑")}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted"
                          data-testid={`project-ai-trigger-edit-${trigger.id}`}
                          onClick={() => setManagerDraft(trigger)}
                          type="button"
                        >
                          <Pencil aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <button
                          aria-label={translate("common.delete", "删除")}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10"
                          data-testid={`project-ai-trigger-remove-${trigger.id}`}
                          onClick={() =>
                            void managerAutomation.saveTriggers(
                              managerAutomation.config!.triggers.filter(
                                (item) => item.id !== trigger.id,
                              ),
                            )
                          }
                          type="button"
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : !editing && !error ? (
              <div className="py-12 text-center text-sm text-text-secondary">
                {translate("todo.no_automatic_processing", "暂无自动处理规则")}
              </div>
            ) : null}
          </>
        )}
      </div>

      {managerDraft && (
        <ProjectManagerTriggerEditor
          trigger={managerDraft}
          locale={locale}
          saving={managerAutomation.saving}
          onChange={setManagerDraft}
          onClose={() => setManagerDraft(null)}
          onSave={() => void saveManagerDraft()}
        />
      )}
      {editing ? (
        <div className="collaboration-dialog-backdrop !bg-black/20">
          <form
            aria-labelledby="automatic-processing-dialog-title"
            aria-modal="true"
            className="collaboration-dialog flex max-h-[calc(100vh-48px)] w-full max-w-[600px] flex-col overflow-hidden !rounded-2xl !p-0 !shadow-lg"
            data-testid="automatic-processing-form"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !saving) {
                if (targetPickerOpen) {
                  event.stopPropagation();
                  setTargetPickerOpen(false);
                  setTargetQuery("");
                  return;
                }
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
                  setTargetPickerOpen(false);
                  setTargetQuery("");
                  setEditing(false);
                  setDraft(EMPTY_DRAFT);
                }}
                type="button"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <div
                className="rounded-xl border border-border bg-muted/40 px-4 py-3"
                data-testid="automatic-processing-preview"
              >
                <p className="text-xs font-medium text-text-secondary">
                  {translate("todo.rule_preview", "规则预览")}
                </p>
                <p className="mt-1 text-sm font-medium text-text-primary">
                  {triggerPreview}
                  <span className="mx-2 text-text-muted">→</span>
                  {selectedTargetName}
                  <span className="ml-1 font-normal text-text-secondary">
                    · {targetKindLabel[draft.targetKind]}
                  </span>
                </p>
              </div>

              <fieldset
                className="grid grid-cols-2 gap-2"
                data-testid="automatic-processing-trigger"
              >
                <legend className="mb-2 text-sm font-medium text-text-primary">
                  {translate("todo.when", "当发生")}
                </legend>
                {TRIGGER_OPTIONS.filter(
                  (option) => option.kind !== "external" || api.incomingHooks,
                ).map((option, index) => {
                  const selected = draft.trigger === option.kind;
                  const Icon = option.icon;
                  const localeIndex = locale === "zh-CN" ? 0 : 1;
                  return (
                    <label
                      className={`!flex min-h-[68px] cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition-colors ${
                        selected
                          ? "automatic-processing-selected"
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
                          selected
                            ? "automatic-processing-selected-icon"
                            : "text-text-secondary"
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

              {draft.trigger !== "created" ? (
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
                        placeholder={translate(
                          "todo.matching_tag_placeholder",
                          "输入需要匹配的 Tag",
                        )}
                        value={draft.tag}
                        onChange={(event) =>
                          updateDraft({ tag: event.target.value })
                        }
                      />
                    </div>
                  ) : null}

                  {draft.trigger === "schedule" ? (
                    <div className="space-y-4 py-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5 text-sm">
                          <span className="block font-medium text-text-primary">
                            {translate("todo.schedule_frequency", "重复")}
                          </span>
                          <select
                            className="h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-focus"
                            data-testid="automatic-processing-schedule-frequency"
                            value={schedule.frequency}
                            onChange={(event) => {
                              const frequency = event.target
                                .value as ScheduleFrequency;
                              if (frequency === "custom") {
                                return;
                              }
                              updateDraft({
                                cronExpression: buildScheduleCron({
                                  ...schedule,
                                  frequency,
                                }),
                              });
                            }}
                          >
                            <option value="daily">
                              {translate("todo.schedule_daily", "每天")}
                            </option>
                            <option value="weekdays">
                              {translate(
                                "todo.schedule_weekdays",
                                "每个工作日",
                              )}
                            </option>
                            <option value="weekly">
                              {translate("todo.schedule_weekly", "每周")}
                            </option>
                            {schedule.frequency === "custom" ? (
                              <option value="custom">
                                {translate(
                                  "todo.schedule_custom",
                                  "自定义 Cron",
                                )}
                              </option>
                            ) : null}
                          </select>
                        </label>

                        <label className="space-y-1.5 text-sm">
                          <span className="block font-medium text-text-primary">
                            {translate("todo.schedule_time", "执行时间")}
                          </span>
                          <input
                            className="h-10 w-full rounded-lg border border-border bg-background px-3 tabular-nums outline-none focus:border-focus"
                            data-testid="automatic-processing-schedule-time"
                            onChange={(event) =>
                              updateDraft({
                                cronExpression: buildScheduleCron({
                                  ...schedule,
                                  frequency:
                                    schedule.frequency === "custom"
                                      ? "weekdays"
                                      : schedule.frequency,
                                  time: event.target.value,
                                }),
                              })
                            }
                            type="time"
                            value={schedule.time}
                          />
                        </label>
                      </div>

                      {schedule.frequency === "weekly" ? (
                        <label className="block space-y-1.5 text-sm">
                          <span className="block font-medium text-text-primary">
                            {translate("todo.schedule_weekday", "星期")}
                          </span>
                          <select
                            className="h-10 w-full rounded-lg border border-border bg-background px-3 outline-none focus:border-focus"
                            data-testid="automatic-processing-schedule-weekday"
                            value={schedule.weekday}
                            onChange={(event) =>
                              updateDraft({
                                cronExpression: buildScheduleCron({
                                  ...schedule,
                                  weekday: event.target.value,
                                }),
                              })
                            }
                          >
                            {WEEKDAY_OPTIONS.map(
                              ([value, zhLabel, enLabel]) => (
                                <option key={value} value={value}>
                                  {locale === "zh-CN" ? zhLabel : enLabel}
                                </option>
                              ),
                            )}
                          </select>
                        </label>
                      ) : null}

                      <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-text-secondary">
                        <CalendarClock
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                        />
                        <span>
                          {scheduleLabel(draft.cronExpression, locale)}
                        </span>
                        <span className="ml-auto text-xs text-text-muted">
                          Asia/Shanghai
                        </span>
                      </div>

                      <details
                        className="group rounded-lg border border-border bg-background"
                        data-testid="automatic-processing-cron-advanced"
                      >
                        <summary
                          className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-sm font-medium text-text-secondary"
                          data-testid="automatic-processing-cron-advanced-toggle"
                        >
                          {translate(
                            "todo.schedule_advanced",
                            "高级设置（Cron）",
                          )}
                          <ChevronDown
                            aria-hidden="true"
                            className="h-4 w-4 transition-transform group-open:rotate-180"
                          />
                        </summary>
                        <div className="space-y-2 border-t border-border px-3 py-3">
                          <label
                            className="sr-only"
                            htmlFor="automatic-processing-cron"
                          >
                            {translate(
                              "todo.schedule_expression",
                              "Cron 表达式",
                            )}
                          </label>
                          <input
                            className="h-9 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm outline-none focus:border-focus"
                            data-testid="automatic-processing-cron"
                            id="automatic-processing-cron"
                            placeholder="0 9 * * 1-5"
                            value={draft.cronExpression}
                            onChange={(event) =>
                              updateDraft({
                                cronExpression: event.target.value,
                              })
                            }
                          />
                          <p className="text-xs text-text-muted">
                            {translate(
                              "todo.schedule_cron_help",
                              "格式：分钟 小时 日 月 星期，例如 0 9 * * 1-5。",
                            )}
                          </p>
                        </div>
                      </details>
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
                          disabled={hooksLoading}
                          value={draft.hookId}
                          onChange={(event) => {
                            const hook = hooks.find(
                              (candidate) =>
                                candidate.id === event.target.value,
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
                            {hooksLoading
                              ? translate("common.loading", "加载中…")
                              : translate("common.select", "请选择")}
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
                          disabled={hooksLoading}
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
                </div>
              ) : null}

              <section className="space-y-2">
                <h3 className="text-sm font-medium text-text-primary">
                  {translate("todo.assign_to", "交给")}
                </h3>
                <div
                  className="grid grid-cols-3 gap-2"
                  data-testid="automatic-processing-target-kinds"
                >
                  {targetKinds.map((targetKind) => {
                    const selected = draft.targetKind === targetKind.kind;
                    const available = targetKind.options.length > 0;
                    const Icon = targetKind.icon;
                    return (
                      <button
                        aria-pressed={selected}
                        className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          selected
                            ? "automatic-processing-selected-soft"
                            : available
                              ? "border-border hover:bg-muted/60"
                              : "cursor-not-allowed border-border/60"
                        }`}
                        data-testid={`automatic-processing-target-kind-${targetKind.kind}`}
                        disabled={!available}
                        key={targetKind.kind}
                        onClick={() => {
                          const firstTarget = targetKind.options[0];
                          updateDraft({
                            targetKind: targetKind.kind,
                            targetId: firstTarget?.id ?? "",
                          });
                          setTargetPickerOpen(false);
                          setTargetQuery("");
                        }}
                        type="button"
                      >
                        <Icon
                          aria-hidden="true"
                          className={`h-4 w-4 shrink-0 ${
                            selected
                              ? "automatic-processing-selected-icon"
                              : "text-text-secondary"
                          }`}
                        />
                        <span className="min-w-0">
                          <strong
                            className={`block truncate text-sm font-medium ${
                              available
                                ? "text-text-primary"
                                : "text-text-muted"
                            }`}
                          >
                            {targetKind.label}
                          </strong>
                          <span
                            className={`block text-xs ${
                              available
                                ? "text-text-secondary"
                                : "text-text-muted"
                            }`}
                          >
                            {available
                              ? locale === "zh-CN"
                                ? `${targetKind.options.length} 个可用`
                                : `${targetKind.options.length} available`
                              : translate("common.not_configured", "未配置")}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="relative">
                  <button
                    aria-expanded={targetPickerOpen}
                    aria-haspopup="listbox"
                    className={`automatic-processing-selected flex min-h-[68px] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-shadow ${
                      targetPickerOpen ? "automatic-processing-picker-open" : ""
                    }`}
                    data-testid="automatic-processing-target"
                    onClick={() => {
                      setTargetPickerOpen((open) => !open);
                      setTargetQuery("");
                    }}
                    type="button"
                  >
                    <span className="automatic-processing-selected-avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                      <SelectedTargetIcon
                        aria-hidden="true"
                        className="h-4 w-4"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium text-text-primary">
                        {selectedTargetName}
                      </strong>
                      <span className="mt-0.5 block text-xs text-text-secondary">
                        {targetKindLabel[draft.targetKind]}
                      </span>
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${
                        targetPickerOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {targetPickerOpen ? (
                    <div
                      className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
                      data-testid="automatic-processing-target-picker"
                    >
                      <div className="border-b border-border p-2">
                        <label className="!flex h-8 items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:border-focus">
                          <Search
                            aria-hidden="true"
                            className="h-4 w-4 shrink-0 text-text-muted"
                          />
                          <input
                            autoFocus
                            className="!h-auto !min-h-0 min-w-0 flex-1 !border-0 !bg-transparent !p-0 text-sm text-text-primary outline-none placeholder:text-text-muted"
                            data-testid="automatic-processing-target-search"
                            onChange={(event) =>
                              setTargetQuery(event.target.value)
                            }
                            placeholder={translate(
                              "todo.search_processing_target",
                              `搜索${targetKindLabel[draft.targetKind]}`,
                            )}
                            value={targetQuery}
                          />
                        </label>
                      </div>
                      <div
                        aria-label={translate(
                          "todo.processing_target",
                          "处理对象",
                        )}
                        className="max-h-52 overflow-y-auto p-2"
                        role="listbox"
                      >
                        {filteredTargets.map((option) => {
                          const selected = draft.targetId === option.id;
                          return (
                            <button
                              aria-selected={selected}
                              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
                              data-testid={`automatic-processing-target-option-${draft.targetKind}-${option.id}`}
                              key={option.id}
                              onClick={() => {
                                updateDraft({ targetId: option.id });
                                setTargetPickerOpen(false);
                                setTargetQuery("");
                              }}
                              role="option"
                              type="button"
                            >
                              <SelectedTargetIcon
                                aria-hidden="true"
                                className="h-4 w-4 shrink-0 text-text-secondary"
                              />
                              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                                {option.name}
                              </span>
                              {selected ? (
                                <Check
                                  aria-hidden="true"
                                  className="automatic-processing-selected-icon h-4 w-4 shrink-0"
                                />
                              ) : null}
                            </button>
                          );
                        })}
                        {!filteredTargets.length ? (
                          <p className="px-3 py-6 text-center text-sm text-text-secondary">
                            {translate(
                              "todo.no_matching_processing_target",
                              "没有匹配的处理对象",
                            )}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>

              <p className="text-xs leading-5 text-text-secondary">
                {translate(
                  "todo.automatic_processing_runner_hint",
                  "执行时从项目的可用设备池中自动选择设备；同一 Issue 后续执行会优先继续使用原设备。",
                )}
              </p>

              {error ? (
                <div className="collaboration-alert" role="alert">
                  {error}
                </div>
              ) : null}
            </div>

            <footer className="flex min-h-14 shrink-0 items-center !justify-between gap-4 border-t border-border px-5 py-3">
              <label className="!flex cursor-pointer items-center gap-2 whitespace-nowrap text-sm text-text-secondary">
                <input
                  checked={draft.enabled}
                  className="automatic-processing-checkbox !h-4 !min-h-0 !w-4 shrink-0 rounded border-border !p-0"
                  data-testid="automatic-processing-enabled"
                  disabled={saving}
                  onChange={(event) =>
                    updateDraft({ enabled: event.target.checked })
                  }
                  type="checkbox"
                />
                {translate("todo.enable_after_creation", "创建后立即启用")}
              </label>
              <div className="flex items-center gap-2">
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
                      : translate(
                          "todo.create_automatic_processing",
                          "创建自动处理",
                        )}
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}
    </ProjectSettingsPage>
  );
}
