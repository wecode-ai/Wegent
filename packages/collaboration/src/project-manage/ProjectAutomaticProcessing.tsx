// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ArrowLeft, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { RuleTargetPicker } from "../automation/RuleTargetPicker";
import { ConnectionRuleDialog } from "../automation/ConnectionRuleDialog";
import { AutomationInstructionField } from "../automation/AutomationInstructionField";
import { collaborationMessages, type CollaborationTranslate } from "../i18n";
import { projectStatuses } from "../board";
import type {
  SharedWorkspaceApi,
  WorkspaceAutomationInput,
  WorkspaceAutomationRule,
  WorkspaceIncomingHook,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
  CollaborationProject,
} from "../types";
import { ProjectRuleConnectionPicker } from "./ProjectRuleConnectionPicker";
import { AutomaticProcessingSwitch } from "./AutomaticProcessingSwitch";
import {
  useProjectConnectionRules,
  type ProjectConnectionRuleOptions,
} from "./useProjectConnectionRules";
import { useAutomaticProcessingRules } from "./useAutomaticProcessingRules";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import { AutomaticProcessingTriggerFields } from "./AutomaticProcessingTriggerFields";
import {
  TARGET_ICONS,
  targetOptionsFor,
  targetLabels,
  EMPTY_DRAFT,
  draftFromRule,
  eventLabel,
  eventTypesForHook,
  scheduleLabel,
  type AutomaticProcessingDraft,
  type TargetKind,
  type TriggerKind,
} from "./automaticProcessing";

export function ProjectAutomaticProcessing({
  api,
  project,
  members,
  agents,
  locale,
  translate,
  connectionRules,
  connectionProject,
  renderConnectionRunnerSelection,
  onOpenConnectionIssue,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  translate: CollaborationTranslate;
} & ProjectConnectionRuleOptions) {
  const {
    rules,
    loading,
    error: rulesError,
    load,
  } = useAutomaticProcessingRules(api.automations, project.id);
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [availableAgents, setAvailableAgents] =
    useState<CollaborationAgent[]>(agents);
  const [availableMembers, setAvailableMembers] =
    useState<CollaborationMember[]>(members);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [hooks, setHooks] = useState<WorkspaceIncomingHook[]>([]);
  const [sourceCatalog, setSourceCatalog] = useState<Record<string, unknown>[]>(
    [],
  );
  const [draft, setDraft] = useState<AutomaticProcessingDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [choosingConnection, setChoosingConnection] = useState(false);
  const [changingConnection, setChangingConnection] = useState(false);
  const [connectionKind, setConnectionKind] = useState<
    "projects" | "time" | "webhook"
  >("projects");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const [hooksError, setHooksError] = useState("");
  const translateRef = useRef(translate);
  translateRef.current = translate;
  const needsHooks = editing && draft.trigger === "external";
  const error =
    actionError ||
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
    setChoosingConnection(false);
    setHooks([]);
    setHooksError("");
    setError("");
  }, [api, project.id, connectionRules?.ownerScope]);

  useEffect(() => {
    let active = true;
    setGroups([]);
    setAvailableMembers([]);
    setOptionsLoading(true);
    setOptionsError("");
    void Promise.all([
      api.projects.listCollaborationGroups?.(project.id) ?? [],
      api.agents.list(project.id),
      api.members.list(project.id),
    ])
      .then(([nextGroups, nextAgents, nextMembers]) => {
        if (!active) return;
        setGroups(nextGroups);
        setAvailableAgents(nextAgents);
        setAvailableMembers(nextMembers);
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
      })
      .finally(() => {
        if (active) setOptionsLoading(false);
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
    void Promise.all([
      api.incomingHooks.list(project.id),
      api.incomingHooks.catalog(),
    ])
      .then(([nextHooks, catalog]) => {
        if (!active) return;
        setHooks(nextHooks);
        setSourceCatalog(catalog);
        const hook = nextHooks[0];
        if (hook)
          setDraft((current) =>
            current.hookId
              ? current
              : {
                  ...current,
                  hookId: hook.id,
                  eventType: eventTypesForHook(hook, catalog)[0] ?? "",
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
    () => targetOptionsFor(availableMembers, availableAgents, groups),
    [availableAgents, groups, availableMembers],
  );
  const targetAvailable = targetOptions[draft.targetKind].some(
    (option) => option.id === draft.targetId,
  );
  const targetKindLabel = targetLabels(translate);
  const selectedTargetName =
    targetOptions[draft.targetKind].find(
      (option) => option.id === draft.targetId,
    )?.name ?? translate("common.select", "请选择");
  const targetKinds = (["human", "agent", "collaboration_group"] as const).map(
    (kind) => ({
      kind,
      label: targetKindLabel[kind],
      icon: TARGET_ICONS[kind],
      options: targetOptions[kind],
    }),
  );
  const statuses = projectStatuses(
    project,
    collaborationMessages[locale],
    translate,
  );
  function statusTriggerLabel(value: AutomaticProcessingDraft): string {
    const label =
      value.statusTransition === "entered_processing"
        ? translate("todo.trigger_entered_processing", "进入处理阶段后")
        : translate("todo.trigger_status_changed", "进入指定状态后");
    const names = value.statuses.map(
      (id) => statuses.find((status) => status.id === id)?.name ?? id,
    );
    return names.length
      ? `${label} · ${names.join(locale === "zh-CN" ? "、" : ", ")}`
      : label;
  }
  const triggerPreview =
    draft.trigger === "created"
      ? translate("todo.trigger_issue_created", "Issue 创建后")
      : draft.trigger === "tag_added"
        ? draft.tag.trim()
          ? `${translate("todo.trigger_tag_added", "添加 Tag 后")} · ${draft.tag.trim()}`
          : translate("todo.trigger_tag_added", "添加指定 Tag 后")
        : draft.trigger === "status_changed"
          ? statusTriggerLabel(draft)
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
    (draft.trigger !== "status_changed" ||
      ((draft.statuses.length > 0 ||
        draft.statusTransition === "entered_processing") &&
        draft.statuses.every((id) =>
          statuses.some((status) => status.id === id),
        ))) &&
    (draft.trigger !== "schedule" || draft.cronExpression.trim()) &&
    (draft.trigger !== "external" || (draft.hookId && draft.eventType)),
  );

  function updateDraft(patch: Partial<AutomaticProcessingDraft>) {
    setDraft((current) => ({
      ...current,
      ...patch,
      ...((patch.targetKind && patch.targetKind !== current.targetKind) ||
      (patch.targetId && patch.targetId !== current.targetId)
        ? { runnerSelection: undefined }
        : {}),
    }));
  }

  function openCreate(
    connection: "projects" | "time" | "webhook" = "projects",
  ) {
    setConnectionKind(connection);
    setChoosingConnection(false);
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
      trigger:
        connection === "time"
          ? "schedule"
          : connection === "webhook"
            ? "external"
            : "created",
      targetKind,
      targetId: target.id,
    });
    setEditing(true);
    setError("");
  }

  function selectTrigger(trigger: TriggerKind) {
    const hook = hooks[0];
    const eventType = hook
      ? (eventTypesForHook(hook, sourceCatalog)[0] ?? "")
      : "";
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

  function inputFromDraft(
    value: AutomaticProcessingDraft,
  ): WorkspaceAutomationInput {
    const isSchedule = value.trigger === "schedule";
    const eventType =
      value.trigger === "created"
        ? "task.created"
        : value.trigger === "tag_added"
          ? "task.tag_added"
          : value.trigger === "status_changed"
            ? "task.status_changed"
            : value.trigger === "external"
              ? value.eventType || null
              : null;
    const eventConfig =
      value.trigger === "tag_added"
        ? { executionTarget: "existing_issue", tags: [value.tag.trim()] }
        : value.trigger === "status_changed"
          ? {
              executionTarget: "existing_issue",
              transition: value.statusTransition,
              ...(value.statuses.length ? { statuses: value.statuses } : {}),
            }
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
          : value.trigger === "status_changed"
            ? statusTriggerLabel(value)
            : value.trigger === "schedule"
              ? translate("todo.trigger_schedule", "按时间定期处理")
              : eventLabel(value.eventType, locale);
    return {
      name: value.name.trim() || `${triggerName} → ${targetName}`,
      prompt: value.prompt.trim()
        ? value.prompt
        : translate(
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
      executionDeviceId: null,
      enabled: value.enabled,
      runnerSelection: value.runnerSelection,
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

  const {
    visibleRules,
    sourcesLoading,
    connectionRulesPanel,
    connectionRulesRef,
    privateRuleCount,
  } = useProjectConnectionRules({
    connectionRules,
    connectionProject,
    renderConnectionRunnerSelection,
    onOpenConnectionIssue,
    rules,
    targetKinds,
    translate,
    disabled: !canManage || optionsLoading || Boolean(optionsError),
    onMutation: () => void load(),
  });

  return (
    <ProjectSettingsPage
      actions={
        canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="collaboration-primary-button inline-flex shrink-0 items-center gap-1.5"
              data-testid="automatic-processing-create"
              disabled={optionsLoading || Boolean(optionsError)}
              ref={createButtonRef}
              onClick={() => {
                connectionRulesRef.current?.reset();
                setDraft(EMPTY_DRAFT);
                setChangingConnection(false);
                setChoosingConnection(true);
              }}
            >
              <Plus aria-hidden="true" className="h-4 w-4" />
              {translate("todo.create_automatic_processing", "新建规则")}
            </button>
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
        {loading || sourcesLoading ? (
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

            {visibleRules.length ? (
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background">
                {visibleRules.map((rule) => {
                  const ruleDraft = draftFromRule(rule);
                  const triggerLabel =
                    ruleDraft.trigger === "created"
                      ? translate("todo.trigger_issue_created", "Issue 创建后")
                      : ruleDraft.trigger === "tag_added"
                        ? `${translate("todo.trigger_tag_added", "添加 Tag 后")} · ${ruleDraft.tag}`
                        : ruleDraft.trigger === "status_changed"
                          ? statusTriggerLabel(ruleDraft)
                          : ruleDraft.trigger === "schedule"
                            ? `${translate("todo.trigger_schedule", "按时间定期处理")} · ${scheduleLabel(ruleDraft.cronExpression, locale)}`
                            : eventLabel(ruleDraft.eventType, locale);
                  const targetName = rule.targetName;
                  return (
                    <article
                      className="flex min-h-14 items-center gap-4 px-4 py-3"
                      data-testid={`automatic-processing-rule-${rule.id}`}
                      key={rule.id}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setConnectionKind(
                            ruleDraft.trigger === "schedule"
                              ? "time"
                              : ruleDraft.trigger === "external"
                                ? "webhook"
                                : "projects",
                          );
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
                              setConnectionKind(
                                ruleDraft.trigger === "schedule"
                                  ? "time"
                                  : ruleDraft.trigger === "external"
                                    ? "webhook"
                                    : "projects",
                              );
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
            ) : !editing && !error && !privateRuleCount ? (
              <div className="py-12 text-center text-sm text-text-secondary">
                {translate(
                  "automation_rules.no_issue_rules",
                  "暂无自动处理规则（Issue / 定时）",
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {connectionRulesPanel}
      {choosingConnection && canManage && (
        <ProjectRuleConnectionPicker
          key={JSON.stringify([connectionRules?.ownerScope, project.id])}
          api={changingConnection && draft.id ? undefined : connectionRules}
          translate={translate}
          returnFocus={createButtonRef.current}
          hasIncomingHooks={Boolean(api.incomingHooks)}
          onClose={() => {
            connectionRulesRef.current?.reset();
            setChoosingConnection(false);
            setChangingConnection(false);
            setEditing(false);
            setDraft(EMPTY_DRAFT);
          }}
          onSelect={(connection) => {
            if (typeof connection === "string") {
              if (changingConnection) {
                setChoosingConnection(false);
                setEditing(true);
                if (connection !== connectionKind) {
                  setConnectionKind(connection);
                  selectTrigger(
                    connection === "time"
                      ? "schedule"
                      : connection === "webhook"
                        ? "external"
                        : "created",
                  );
                }
              } else openCreate(connection);
            } else {
              setChoosingConnection(false);
              connectionRulesRef.current?.create(
                connection,
                createButtonRef.current,
                () => setChoosingConnection(true),
              );
            }
          }}
        />
      )}

      {editing ? (
        <ConnectionRuleDialog
          label={translate("todo.automatic_processing", "自动处理")}
          returnFocus={createButtonRef.current}
        >
          <form
            aria-labelledby="automatic-processing-dialog-title"
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
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
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
              <button
                type="button"
                data-testid="automatic-processing-back"
                disabled={saving}
                aria-label={translate("automation_rules.back", "返回")}
                className="mr-2 flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                onClick={() => {
                  setEditing(false);
                  setChangingConnection(true);
                  setChoosingConnection(true);
                }}
              >
                <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              </button>
              <h2
                className="heading-small !m-0 flex-1"
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

              <AutomaticProcessingTriggerFields
                connectionKind={connectionKind}
                sourceCatalog={sourceCatalog}
                draft={draft}
                updateDraft={updateDraft}
                selectTrigger={selectTrigger}
                locale={locale}
                translate={translate}
                hooks={hooks}
                hooksLoading={hooksLoading}
                hasIncomingHooks={Boolean(api.incomingHooks)}
                statuses={statuses}
              />

              <RuleTargetPicker
                value={{ kind: draft.targetKind, id: draft.targetId }}
                options={targetOptions}
                onChange={(value) =>
                  updateDraft({ targetKind: value.kind, targetId: value.id })
                }
                translate={translate}
                testId="automatic-processing"
              />

              <div className="space-y-2">
                <label
                  className="block text-sm font-medium text-text-primary"
                  htmlFor="automatic-processing-prompt"
                >
                  {translate(
                    "todo.automatic_processing_prompt",
                    "提示词（可选）",
                  )}
                </label>
                <AutomationInstructionField
                  aria-describedby="automatic-processing-prompt-hint"
                  data-testid="automatic-processing-prompt"
                  disabled={saving}
                  id="automatic-processing-prompt"
                  maxLength={100000}
                  onChange={(event) =>
                    updateDraft({ prompt: event.target.value })
                  }
                  rows={4}
                  value={draft.prompt}
                />
                <p
                  className="text-xs leading-5 text-text-secondary"
                  id="automatic-processing-prompt-hint"
                >
                  {translate(
                    "todo.automatic_processing_prompt_hint",
                    "触发时发送给 AI，用于处理当前 Issue；留空按目标职责处理。",
                  )}
                </p>
              </div>

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
        </ConnectionRuleDialog>
      ) : null}
    </ProjectSettingsPage>
  );
}
