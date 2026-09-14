// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Bot,
  CalendarClock,
  Check,
  ChevronRight,
  CirclePause,
  Clock3,
  History,
  LoaderCircle,
  Play,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  AutomationUiRule,
  AutomationUiRun,
  AutomationUiStep,
  WorkflowContextSource,
} from "../automation";
import type {
  AutomationProjectAgentOption,
  AutomationRulesViewProps,
} from "./AutomationRulesView.types";
import { useAutomationLocale, useTranslation } from "./AutomationUiHost";
import { SequentialWorkflowSteps } from "./SequentialWorkflowSteps";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
type Translate = (
  key: string,
  values?: Record<string, string | number | null | undefined>,
) => string;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const TIMEZONES = [
  "UTC",
  "Asia/Shanghai",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
] as const;

function cloneRule(rule: AutomationUiRule): AutomationUiRule {
  const cloneStep = (step: AutomationUiStep): AutomationUiStep => ({
    ...step,
    dependencies: [...step.dependencies],
    dependencyContext: Object.fromEntries(
      Object.entries(step.dependencyContext).map(([id, sources]) => [
        id,
        [...sources],
      ]),
    ),
    deliverables: step.deliverables.map((item) => ({ ...item })),
    modelOptions: { ...step.modelOptions },
    plugins: [...step.plugins],
    projectPlugins: step.projectPlugins.map((item) => ({ ...item })),
    executionConfig: step.executionConfig
      ? {
          ...step.executionConfig,
          model_options: { ...step.executionConfig.model_options },
          project_plugins: [...(step.executionConfig.project_plugins ?? [])],
        }
      : null,
    subgraph: step.subgraph
      ? { nodes: step.subgraph.nodes.map(cloneStep) }
      : null,
  });

  return {
    ...rule,
    trigger: {
      ...rule.trigger,
      tags: [...rule.trigger.tags],
      targetBranches: [...(rule.trigger.targetBranches ?? [])],
      repositories: [...(rule.trigger.repositories ?? [])],
      schedule: { ...rule.trigger.schedule },
    },
    steps: rule.steps.map(cloneStep),
  };
}

function dynamicCoordinator(
  prompt = "",
  approvalPolicy: "required" | "automatic" = "required",
  name = "Project manager agent",
): AutomationUiStep {
  return {
    id: `coordinator-${crypto.randomUUID()}`,
    name,
    prompt,
    kind: "dynamic",
    dependencies: [],
    dependencyContext: {},
    x: 0,
    y: 0,
    deliverables: [],
    executionMode: "automatic",
    environment: "",
    executionEnvironment: "local",
    executionDeviceId: null,
    runtimeProfileId: null,
    model: "",
    modelType: null,
    modelOptions: {},
    plugins: [],
    projectPlugins: [],
    workspacePolicy: "composer",
    required: true,
    automationRuleId: null,
    executionConfig: null,
    executionConfigOverride: false,
    approvalPolicy,
    nodeType: "task",
    role: null,
    loopId: null,
    bodyNodeIds: [],
    loopConfig: null,
    branchConditions: [],
    eventWait: null,
    subgraph: { nodes: [] },
  };
}

function workflowLabelStep(t: Translate, index: number): AutomationUiStep {
  return {
    id: `workflow-step-${crypto.randomUUID()}`,
    name: t("automation.policy.stepFallback", { index }),
    prompt: "",
    kind: "task",
    dependencies: [],
    dependencyContext: {},
    x: 0,
    y: 0,
    deliverables: [],
    executionMode: "automatic",
    environment: "",
    executionEnvironment: "local",
    executionDeviceId: null,
    runtimeProfileId: null,
    model: "",
    modelType: null,
    modelOptions: {},
    plugins: [],
    projectPlugins: [],
    workspacePolicy: "none",
    required: true,
    automationRuleId: null,
    executionConfig: null,
    executionConfigOverride: false,
    nodeType: "task",
    role: null,
    loopId: null,
    bodyNodeIds: [],
    loopConfig: null,
    branchConditions: [],
    eventWait: null,
    subgraph: null,
  };
}

function workflowStepWithRequiredAssignee(
  step: AutomationUiStep,
  agentId: string,
): AutomationUiStep {
  return {
    ...step,
    executionMode: "automatic",
    requiredAssigneeType: agentId ? "agent" : null,
    requiredAssigneeId: agentId || null,
    executionConfig: null,
    executionConfigOverride: false,
  };
}

const LINEAR_WORKFLOW_CONTEXT: WorkflowContextSource[] = [
  "final_result",
  "deliveries",
];

function linearWorkflowSteps(steps: AutomationUiStep[]): AutomationUiStep[] {
  return steps.map((step, index) => {
    const previous = steps[index - 1];
    if (!previous) {
      return {
        ...step,
        dependencies: [],
        dependencyContext: {},
      };
    }
    const context =
      step.dependencyContext[previous.id] ?? LINEAR_WORKFLOW_CONTEXT;
    return {
      ...step,
      dependencies: [previous.id],
      dependencyContext: {
        [previous.id]: [...context],
      },
    };
  });
}

function linearizeCoordinatorWorkflow(rule: AutomationUiRule) {
  const coordinator = coordinatorStep(rule);
  if (!coordinator) return rule;
  return {
    ...rule,
    steps: [
      {
        ...coordinator,
        subgraph: {
          nodes: linearWorkflowSteps(coordinator.subgraph?.nodes ?? []),
        },
      },
    ],
  };
}

function newPolicyRule(t: Translate): AutomationUiRule {
  return {
    id: `draft-${crypto.randomUUID()}`,
    persisted: false,
    origin: "automation",
    version: 1,
    name: t("automation.policy.defaultName"),
    description: "",
    enabled: true,
    updatedAt: t("automation.policy.unsaved"),
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: "event",
      source: "wework",
      collectionMode: "internal",
      startMode: "immediate",
      event: "created",
      tags: [],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "09:00",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [
      dynamicCoordinator(
        t("automation.policy.defaultPrompt"),
        "required",
        t("automation.policy.defaultManager"),
      ),
    ],
    legacyDefinition: null,
    runtimeSource: "runtime_user",
  };
}

function coordinatorStep(rule: AutomationUiRule): AutomationUiStep | null {
  return rule.steps.length === 1 && rule.steps[0]?.kind === "dynamic"
    ? rule.steps[0]
    : null;
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function replaceCoordinator(
  rule: AutomationUiRule,
  update: (step: AutomationUiStep) => AutomationUiStep,
  managerName: string,
): AutomationUiRule {
  const current =
    coordinatorStep(rule) ?? dynamicCoordinator("", "required", managerName);
  return { ...rule, steps: [update(current)] };
}

export function AutomationPolicyView({
  rules,
  runs,
  loading = false,
  error = "",
  canManage = true,
  projectTags = [],
  projectAgents = [],
  onReload,
  onLoadRuns,
  onOpenIssue,
  onRunRule,
  onSaveRule,
  onToggleRule,
  onDeleteRule,
}: AutomationRulesViewProps) {
  const locale = useAutomationLocale();
  const { t } = useTranslation("common");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => rules[0]?.id ?? null,
  );
  const [draft, setDraft] = useState<AutomationUiRule | null>(() =>
    rules[0] ? cloneRule(rules[0]) : null,
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [actionError, setActionError] = useState("");
  const [showRuns, setShowRuns] = useState(false);
  const [running, setRunning] = useState(false);
  const [deletedRuleIds, setDeletedRuleIds] = useState<Set<string>>(
    () => new Set(),
  );

  const availableRules = useMemo(
    () => rules.filter((rule) => !deletedRuleIds.has(rule.id)),
    [deletedRuleIds, rules],
  );

  useEffect(() => {
    if (saveState === "dirty" || saveState === "saving") return;
    const selected =
      availableRules.find((rule) => rule.id === selectedId) ??
      availableRules[0] ??
      null;
    setSelectedId(selected?.id ?? null);
    setDraft(selected ? cloneRule(selected) : null);
  }, [availableRules, saveState, selectedId]);

  const selectedRuns = useMemo(
    () =>
      runs
        .filter((run) => !draft || run.ruleId === draft.id)
        .sort(
          (left, right) =>
            Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt),
        ),
    [draft, runs],
  );

  const updateDraft = (
    update: (rule: AutomationUiRule) => AutomationUiRule,
  ) => {
    setDraft((current) => (current ? update(current) : current));
    setSaveState("dirty");
    setActionError("");
  };

  const canDiscardDraft = () =>
    saveState !== "dirty" && saveState !== "error" && saveState !== "saving";

  const confirmDiscardDraft = () =>
    canDiscardDraft() ||
    window.confirm(t("automation.policy.discardChangesConfirm"));

  const createRule = () => {
    if (!confirmDiscardDraft()) return;
    const rule = newPolicyRule(t);
    setSelectedId(rule.id);
    setDraft(rule);
    setSaveState("dirty");
    setActionError("");
    setShowRuns(false);
  };

  const selectRule = (ruleId: string) => {
    if (ruleId === selectedId) return;
    if (!confirmDiscardDraft()) {
      setDraft((current) => (current ? cloneRule(current) : current));
      return;
    }
    const selected = availableRules.find((rule) => rule.id === ruleId);
    if (!selected) return;
    setSelectedId(selected.id);
    setDraft(cloneRule(selected));
    setSaveState("idle");
    setActionError("");
    setShowRuns(false);
  };

  const save = async () => {
    if (!draft || !onSaveRule || !canManage) return;
    if (!draft.name.trim()) {
      setActionError(t("automation.policy.nameRequired"));
      return;
    }
    const coordinator = coordinatorStep(draft);
    if (coordinator && !coordinator.prompt.trim()) {
      setActionError(t("automation.policy.promptRequired"));
      return;
    }
    const unassignedStepIndex =
      coordinator?.subgraph?.nodes.findIndex(
        (step) =>
          step.requiredAssigneeType !== "agent" || !step.requiredAssigneeId,
      ) ?? -1;
    if (unassignedStepIndex >= 0) {
      setActionError(
        t("automation.policy.stepAgentRequired", {
          index: unassignedStepIndex + 1,
        }),
      );
      return;
    }
    setSaveState("saving");
    setActionError("");
    try {
      const saved = await onSaveRule(linearizeCoordinatorWorkflow(draft));
      if (!saved) {
        setSaveState("idle");
        return;
      }
      setDraft(cloneRule(saved));
      setSelectedId(saved.id);
      setSaveState("saved");
    } catch (saveError) {
      setActionError(
        saveError instanceof Error
          ? saveError.message
          : t("automation.policy.saveFailed"),
      );
      setSaveState("error");
    }
  };

  const toggleEnabled = async () => {
    if (!draft || !onToggleRule || !draft.persisted) return;
    setActionError("");
    try {
      const saved = await onToggleRule(draft, !draft.enabled);
      if (!saved) return;
      setDraft(cloneRule(saved));
      setSelectedId(saved.id);
    } catch (toggleError) {
      setActionError(
        toggleError instanceof Error
          ? toggleError.message
          : t("automation.policy.updateFailed"),
      );
    }
  };

  const runNow = async () => {
    if (!draft || !onRunRule || !draft.persisted || !canManage) return;
    if (!window.confirm(t("automation.policy.runConfirm"))) return;
    setRunning(true);
    setActionError("");
    try {
      await onRunRule(draft);
      await onLoadRuns?.();
      setShowRuns(true);
    } catch (runError) {
      setActionError(
        runError instanceof Error
          ? runError.message
          : t("automation.policy.runFailed"),
      );
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!draft || !onDeleteRule || !draft.persisted) return;
    if (
      !window.confirm(
        t("automation.policy.deleteConfirm", { name: draft.name }),
      )
    )
      return;
    setActionError("");
    try {
      await onDeleteRule(draft);
      const nextRule = availableRules.find((rule) => rule.id !== draft.id);
      setDeletedRuleIds((current) => new Set(current).add(draft.id));
      setSelectedId(nextRule?.id ?? null);
      setDraft(nextRule ? cloneRule(nextRule) : null);
      setSaveState("idle");
      setShowRuns(false);
    } catch (deleteError) {
      setActionError(
        deleteError instanceof Error
          ? deleteError.message
          : t("automation.policy.deleteFailed"),
      );
    }
  };

  if (loading && !draft && rules.length === 0) {
    return (
      <div className="automation-policy-state" data-testid="automation-loading">
        <LoaderCircle className="automation-policy-spin" size={22} />
        <span>{t("automation.policy.loading")}</span>
      </div>
    );
  }

  return (
    <section
      className="automation-policy"
      data-testid="project-automation-policy"
    >
      <header className="automation-policy-page-header">
        <div>
          <h2 className="text-heading-sm font-medium">
            {t("automation.policy.title")}
          </h2>
          <p className="text-sm">{t("automation.policy.description")}</p>
        </div>
        <button
          type="button"
          className="automation-policy-history-button"
          data-testid="automation-open-runs"
          onClick={async () => {
            await onLoadRuns?.();
            setShowRuns(true);
          }}
        >
          <History size={17} />
          {t("automation.runs.title")}
          <span className="text-xs">{runs.length}</span>
        </button>
      </header>

      <main className="automation-policy-main">
        {error || actionError ? (
          <div className="automation-policy-error" role="alert">
            <span>{actionError || error}</span>
            {error && onReload ? (
              <button type="button" onClick={() => void onReload()}>
                <RotateCcw size={15} />
                {t("automation.policy.reload")}
              </button>
            ) : null}
          </div>
        ) : null}

        {showRuns ? (
          <RunHistory
            runs={selectedRuns}
            ruleName={draft?.name}
            locale={locale}
            t={t}
            onBack={() => setShowRuns(false)}
            onOpenIssue={onOpenIssue}
          />
        ) : draft ? (
          <PolicyEditor
            rule={draft}
            rules={
              availableRules.some((rule) => rule.id === draft.id)
                ? availableRules
                : [draft, ...availableRules]
            }
            projectTags={projectTags}
            canManage={canManage}
            saveState={saveState}
            running={running}
            projectAgents={projectAgents}
            t={t}
            updateDraft={updateDraft}
            onSelectRule={selectRule}
            onCreateRule={createRule}
            onSave={() => void save()}
            onToggle={() => void toggleEnabled()}
            onRun={() => void runNow()}
            onDelete={() => void remove()}
          />
        ) : (
          <div className="automation-policy-welcome">
            <div className="automation-policy-welcome-icon">
              <Bot size={30} />
            </div>
            <h2>{t("automation.policy.welcomeTitle")}</h2>
            <p>{t("automation.policy.welcomeDescription")}</p>
            {canManage ? (
              <button
                type="button"
                data-testid="automation-welcome-create-policy"
                onClick={createRule}
              >
                <Plus size={17} />
                {t("automation.policy.createFirst")}
              </button>
            ) : null}
          </div>
        )}
      </main>
    </section>
  );
}

function PolicyEditor({
  rule,
  rules,
  projectTags,
  canManage,
  saveState,
  running,
  projectAgents,
  t,
  updateDraft,
  onSelectRule,
  onCreateRule,
  onSave,
  onToggle,
  onRun,
  onDelete,
}: {
  rule: AutomationUiRule;
  rules: AutomationUiRule[];
  projectTags: string[];
  canManage: boolean;
  saveState: SaveState;
  running: boolean;
  projectAgents: AutomationProjectAgentOption[];
  t: Translate;
  updateDraft(update: (rule: AutomationUiRule) => AutomationUiRule): void;
  onSelectRule(ruleId: string): void;
  onCreateRule(): void;
  onSave(): void;
  onToggle(): void;
  onRun(): void;
  onDelete(): void;
}) {
  const coordinator = coordinatorStep(rule);
  const fixedSteps = coordinator
    ? linearWorkflowSteps(coordinator.subgraph?.nodes ?? [])
    : rule.steps;
  const [selectedWorkflowStepId, setSelectedWorkflowStepId] = useState<
    string | null
  >(null);
  useEffect(() => {
    setSelectedWorkflowStepId(null);
  }, [rule.id]);
  const selectedWorkflowStepIndex = fixedSteps.findIndex(
    (step) => step.id === selectedWorkflowStepId,
  );
  const selectedWorkflowStep =
    selectedWorkflowStepIndex >= 0
      ? fixedSteps[selectedWorkflowStepIndex]
      : null;
  const updateWorkflowLabels = (
    update: (steps: AutomationUiStep[]) => AutomationUiStep[],
  ) => {
    if (!coordinator) return;
    updateDraft((current) =>
      replaceCoordinator(
        current,
        (step) => ({
          ...step,
          subgraph: {
            nodes: linearWorkflowSteps(
              update(linearWorkflowSteps(step.subgraph?.nodes ?? [])),
            ),
          },
        }),
        t("automation.policy.defaultManager"),
      ),
    );
  };
  const addWorkflowLabel = () => {
    const next = workflowLabelStep(t, fixedSteps.length + 1);
    updateWorkflowLabels((steps) => [...steps, next]);
    setSelectedWorkflowStepId(next.id);
  };
  const saveLabel = {
    idle: t("automation.policy.save"),
    dirty: t("automation.policy.saveChanges"),
    saving: t("automation.policy.saving"),
    saved: t("automation.policy.saved"),
    error: t("automation.policy.retrySave"),
  }[saveState];

  return (
    <div className="automation-policy-editor">
      <header className="automation-policy-editor-header">
        <div className="automation-policy-editor-heading">
          <div className="automation-policy-switcher">
            <select
              value={rule.id}
              disabled={saveState === "saving"}
              aria-label={t("automation.policy.select")}
              data-testid="automation-policy-selector"
              onChange={(event) => onSelectRule(event.target.value)}
            >
              {rules.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                  {!option.persisted
                    ? ` · ${t("automation.policy.unsaved")}`
                    : ""}
                </option>
              ))}
            </select>
            {canManage ? (
              <button
                type="button"
                className="automation-policy-secondary-button"
                disabled={saveState === "saving"}
                data-testid="automation-create-policy"
                onClick={onCreateRule}
              >
                <Plus size={16} />
                {t("automation.policy.create")}
              </button>
            ) : null}
          </div>
          <input
            value={rule.name}
            disabled={!canManage}
            data-testid="automation-policy-name"
            aria-label={t("automation.editor.name")}
            onChange={(event) =>
              updateDraft((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
          />
          <p>{t("automation.policy.ruleDescription")}</p>
        </div>
        <div className="automation-policy-header-actions">
          {rule.persisted ? (
            <>
              <button
                type="button"
                className="automation-policy-secondary-button"
                data-testid="automation-run-now"
                disabled={!canManage || running}
                onClick={onRun}
              >
                {running ? (
                  <LoaderCircle className="automation-policy-spin" size={16} />
                ) : (
                  <Play size={16} />
                )}
                {t("automation.policy.runNow")}
              </button>
              <button
                type="button"
                className="automation-policy-secondary-button"
                data-testid="automation-toggle-policy"
                disabled={!canManage}
                onClick={onToggle}
              >
                {rule.enabled ? <CirclePause size={16} /> : <Play size={16} />}
                {rule.enabled
                  ? t("automation.policy.disable")
                  : t("automation.policy.enable")}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="automation-policy-primary-button"
            data-testid="automation-save-policy"
            disabled={!canManage || saveState === "saving"}
            onClick={onSave}
          >
            {saveState === "saving" ? (
              <LoaderCircle className="automation-policy-spin" size={16} />
            ) : saveState === "saved" ? (
              <Check size={16} />
            ) : (
              <Save size={16} />
            )}
            {saveLabel}
          </button>
        </div>
      </header>

      <div className="automation-policy-form">
        <section className="automation-policy-card">
          <div className="automation-policy-card-title">
            <span>1</span>
            <div>
              <h3>{t("automation.policy.triggerTitle")}</h3>
              <p>{t("automation.policy.triggerDescription")}</p>
            </div>
          </div>
          <div className="automation-policy-choice-grid">
            <label
              className={`automation-policy-choice${rule.trigger.type === "event" && rule.trigger.startMode === "immediate" ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="trigger"
                checked={
                  rule.trigger.type === "event" &&
                  rule.trigger.startMode === "immediate"
                }
                disabled={!canManage}
                data-testid="automation-trigger-created"
                onChange={() =>
                  updateDraft((current) => ({
                    ...current,
                    trigger: {
                      ...current.trigger,
                      type: "event",
                      source: "wework",
                      event: "created",
                      startMode: "immediate",
                    },
                  }))
                }
              />
              <Sparkles size={19} />
              <span>
                <strong>{t("automation.policy.triggerCreated")}</strong>
                <small>
                  {t("automation.policy.triggerCreatedDescription")}
                </small>
              </span>
            </label>
            <label
              className={`automation-policy-choice${rule.trigger.type === "event" && rule.trigger.startMode === "status" ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="trigger"
                checked={
                  rule.trigger.type === "event" &&
                  rule.trigger.startMode === "status"
                }
                disabled={!canManage}
                data-testid="automation-trigger-started"
                onChange={() =>
                  updateDraft((current) => ({
                    ...current,
                    trigger: {
                      ...current.trigger,
                      type: "event",
                      source: "wework",
                      event: "status_changed",
                      startMode: "status",
                    },
                  }))
                }
              />
              <Play size={19} />
              <span>
                <strong>{t("automation.policy.triggerStarted")}</strong>
                <small>
                  {t("automation.policy.triggerStartedDescription")}
                </small>
              </span>
            </label>
            <label
              className={`automation-policy-choice${rule.trigger.type === "schedule" ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="trigger"
                checked={rule.trigger.type === "schedule"}
                disabled={!canManage}
                data-testid="automation-trigger-schedule"
                onChange={() =>
                  updateDraft((current) => ({
                    ...current,
                    trigger: { ...current.trigger, type: "schedule" },
                  }))
                }
              />
              <CalendarClock size={19} />
              <span>
                <strong>{t("automation.policy.triggerSchedule")}</strong>
                <small>
                  {t("automation.policy.triggerScheduleDescription")}
                </small>
              </span>
            </label>
          </div>

          {rule.trigger.type === "event" ? (
            <label className="automation-policy-field">
              <span>{t("automation.policy.tags")}</span>
              <input
                value={rule.trigger.tags.join("、")}
                disabled={!canManage}
                list="automation-project-tags"
                data-testid="automation-trigger-tags"
                placeholder={t("automation.policy.tagsPlaceholder")}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    trigger: {
                      ...current.trigger,
                      tags: event.target.value
                        .split(/[、,，]/)
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    },
                  }))
                }
              />
              <datalist id="automation-project-tags">
                {projectTags.map((tag) => (
                  <option key={tag} value={tag} />
                ))}
              </datalist>
            </label>
          ) : (
            <div className="automation-policy-schedule-fields">
              <label className="automation-policy-field">
                <span>{t("automation.policy.frequency")}</span>
                <select
                  value={rule.trigger.schedule.frequency}
                  disabled={!canManage}
                  data-testid="automation-schedule-frequency"
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      trigger: {
                        ...current.trigger,
                        schedule: {
                          ...current.trigger.schedule,
                          frequency: event.target.value as
                            | "hourly"
                            | "daily"
                            | "weekdays"
                            | "weekly",
                        },
                      },
                    }))
                  }
                >
                  <option value="hourly">
                    {t("automation.policy.hourly")}
                  </option>
                  <option value="daily">{t("automation.policy.daily")}</option>
                  <option value="weekdays">
                    {t("automation.policy.weekdays")}
                  </option>
                  <option value="weekly">
                    {t("automation.policy.weekly")}
                  </option>
                </select>
              </label>
              {rule.trigger.schedule.frequency === "weekly" ? (
                <label className="automation-policy-field">
                  <span>{t("automation.policy.weekday")}</span>
                  <select
                    value={rule.trigger.schedule.weekday}
                    disabled={!canManage}
                    data-testid="automation-schedule-weekday"
                    onChange={(event) =>
                      updateDraft((current) => ({
                        ...current,
                        trigger: {
                          ...current.trigger,
                          schedule: {
                            ...current.trigger.schedule,
                            weekday: event.target.value,
                          },
                        },
                      }))
                    }
                  >
                    {WEEKDAYS.map((weekday) => (
                      <option key={weekday} value={weekday}>
                        {t(`automation.policy.${weekday}`)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="automation-policy-field">
                <span>{t("automation.policy.time")}</span>
                <input
                  type="time"
                  value={rule.trigger.schedule.time}
                  disabled={!canManage}
                  data-testid="automation-schedule-time"
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      trigger: {
                        ...current.trigger,
                        schedule: {
                          ...current.trigger.schedule,
                          time: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="automation-policy-field">
                <span>{t("automation.policy.timezone")}</span>
                <select
                  value={rule.trigger.schedule.timezone}
                  disabled={!canManage}
                  data-testid="automation-schedule-timezone"
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      trigger: {
                        ...current.trigger,
                        schedule: {
                          ...current.trigger.schedule,
                          timezone: event.target.value,
                        },
                      },
                    }))
                  }
                >
                  {!TIMEZONES.includes(
                    rule.trigger.schedule
                      .timezone as (typeof TIMEZONES)[number],
                  ) ? (
                    <option value={rule.trigger.schedule.timezone}>
                      {rule.trigger.schedule.timezone}
                    </option>
                  ) : null}
                  {TIMEZONES.map((timezone) => (
                    <option key={timezone} value={timezone}>
                      {timezone}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>

        <section className="automation-policy-card">
          <div className="automation-policy-card-title">
            <span>2</span>
            <div>
              <h3>{t("automation.policy.coordinatorTitle")}</h3>
              <p>{t("automation.policy.coordinatorDescription")}</p>
            </div>
          </div>

          {coordinator ? (
            <>
              <label className="automation-policy-field">
                <span>{t("automation.policy.principle")}</span>
                <textarea
                  value={coordinator.prompt}
                  disabled={!canManage}
                  data-testid="automation-coordinator-prompt"
                  rows={6}
                  placeholder={t("automation.policy.principlePlaceholder")}
                  onChange={(event) =>
                    updateDraft((current) =>
                      replaceCoordinator(
                        current,
                        (step) => ({
                          ...step,
                          prompt: event.target.value,
                        }),
                        t("automation.policy.defaultManager"),
                      ),
                    )
                  }
                />
              </label>
              <div className="automation-policy-approval">
                <span>{t("automation.policy.approvalQuestion")}</span>
                <div className="automation-policy-segmented">
                  <button
                    type="button"
                    className={
                      coordinator.approvalPolicy !== "automatic"
                        ? "is-selected"
                        : ""
                    }
                    disabled={!canManage}
                    data-testid="automation-approval-required"
                    onClick={() =>
                      updateDraft((current) =>
                        replaceCoordinator(
                          current,
                          (step) => ({
                            ...step,
                            approvalPolicy: "required",
                          }),
                          t("automation.policy.defaultManager"),
                        ),
                      )
                    }
                  >
                    {t("automation.policy.approvalRequired")}
                  </button>
                  <button
                    type="button"
                    className={
                      coordinator.approvalPolicy === "automatic"
                        ? "is-selected"
                        : ""
                    }
                    disabled={!canManage}
                    data-testid="automation-approval-automatic"
                    onClick={() =>
                      updateDraft((current) =>
                        replaceCoordinator(
                          current,
                          (step) => ({
                            ...step,
                            approvalPolicy: "automatic",
                          }),
                          t("automation.policy.defaultManager"),
                        ),
                      )
                    }
                  >
                    {t("automation.policy.approvalAutomatic")}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="automation-policy-legacy-note">
              <Bot size={20} />
              <div>
                <strong>{t("automation.policy.fixedTitle")}</strong>
                <p>{t("automation.policy.fixedDescription")}</p>
              </div>
            </div>
          )}
        </section>

        <section className="automation-policy-card">
          <div className="automation-policy-card-title">
            <span>3</span>
            <div>
              <h3>{t("automation.policy.stepsTitle")}</h3>
              <p>{t("automation.policy.stepsDescription")}</p>
            </div>
            {coordinator && canManage ? (
              <button
                type="button"
                className="automation-policy-add-step"
                data-testid="automation-add-workflow-step"
                onClick={addWorkflowLabel}
              >
                <Plus size={15} />
                {t("automation.policy.addStep")}
              </button>
            ) : null}
          </div>
          {fixedSteps.length ? (
            <SequentialWorkflowSteps
              steps={fixedSteps}
              selectedStepId={selectedWorkflowStepId}
              canManage={Boolean(coordinator && canManage)}
              stepFallback={(index) =>
                t("automation.policy.stepFallback", { index })
              }
              emptyDescription={t("automation.policy.stepNoDescription")}
              executorName={(step) =>
                projectAgents.find(
                  (agent) => agent.id === step.requiredAssigneeId,
                )?.name ?? null
              }
              onSelectStep={setSelectedWorkflowStepId}
            />
          ) : coordinator && canManage ? (
            <button
              type="button"
              className="automation-policy-step-empty automation-policy-step-empty-action"
              data-testid="automation-empty-add-workflow-step"
              onClick={addWorkflowLabel}
            >
              <span>{t("automation.policy.dynamicTitle")}</span>
              <p>{t("automation.policy.dynamicDescription")}</p>
              <strong>
                <Plus size={15} />
                {t("automation.policy.addFirstStep")}
              </strong>
            </button>
          ) : (
            <div className="automation-policy-step-empty">
              <span>{t("automation.policy.dynamicTitle")}</span>
              <p>{t("automation.policy.dynamicDescription")}</p>
            </div>
          )}
          {selectedWorkflowStep && coordinator && canManage ? (
            <div
              className="automation-policy-step-editor"
              data-testid="automation-workflow-step-editor"
            >
              <div className="automation-policy-step-editor-heading">
                <span>{selectedWorkflowStepIndex + 1}</span>
                <strong>{t("automation.policy.editStep")}</strong>
                <button
                  type="button"
                  aria-label={t("automation.policy.removeStep", {
                    name:
                      selectedWorkflowStep.name ||
                      t("automation.policy.stepFallback", {
                        index: selectedWorkflowStepIndex + 1,
                      }),
                  })}
                  data-testid={`automation-remove-workflow-step-${selectedWorkflowStepIndex}`}
                  onClick={() => {
                    updateWorkflowLabels((steps) =>
                      steps.filter(
                        (candidate) => candidate.id !== selectedWorkflowStep.id,
                      ),
                    );
                    setSelectedWorkflowStepId(null);
                  }}
                >
                  <Trash2 size={15} />
                  {t("automation.policy.deleteStep")}
                </button>
              </div>
              <label>
                <span>{t("automation.policy.stepName")}</span>
                <input
                  value={selectedWorkflowStep.name}
                  data-testid={`automation-workflow-step-name-${selectedWorkflowStepIndex}`}
                  placeholder={t("automation.policy.stepNamePlaceholder")}
                  onChange={(event) =>
                    updateWorkflowLabels((steps) =>
                      steps.map((candidate) =>
                        candidate.id === selectedWorkflowStep.id
                          ? { ...candidate, name: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
              </label>
              <label>
                <span>{t("automation.policy.stepAgent")}</span>
                <select
                  value={selectedWorkflowStep.requiredAssigneeId ?? ""}
                  data-testid={`automation-workflow-step-agent-${selectedWorkflowStepIndex}`}
                  onChange={(event) =>
                    updateWorkflowLabels((steps) =>
                      steps.map((candidate) =>
                        candidate.id === selectedWorkflowStep.id
                          ? workflowStepWithRequiredAssignee(
                              candidate,
                              event.target.value,
                            )
                          : candidate,
                      ),
                    )
                  }
                >
                  <option value="">
                    {t("automation.policy.stepAgentPlaceholder")}
                  </option>
                  {selectedWorkflowStep.requiredAssigneeId &&
                  !projectAgents.some(
                    (agent) =>
                      agent.id === selectedWorkflowStep.requiredAssigneeId,
                  ) ? (
                    <option value={selectedWorkflowStep.requiredAssigneeId}>
                      {t("automation.policy.stepAgentUnavailable", {
                        id: selectedWorkflowStep.requiredAssigneeId,
                      })}
                    </option>
                  ) : null}
                  {projectAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("automation.policy.stepDescription")}</span>
                <textarea
                  value={selectedWorkflowStep.prompt}
                  data-testid={`automation-workflow-step-description-${selectedWorkflowStepIndex}`}
                  rows={3}
                  placeholder={t(
                    "automation.policy.stepDescriptionPlaceholder",
                  )}
                  onChange={(event) =>
                    updateWorkflowLabels((steps) =>
                      steps.map((candidate) =>
                        candidate.id === selectedWorkflowStep.id
                          ? { ...candidate, prompt: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
              </label>
            </div>
          ) : null}
        </section>
      </div>

      {rule.persisted && canManage ? (
        <footer className="automation-policy-danger-zone">
          <button
            type="button"
            data-testid="automation-delete-policy"
            onClick={onDelete}
          >
            <Trash2 size={16} />
            {t("automation.policy.delete")}
          </button>
        </footer>
      ) : null}
    </div>
  );
}

function RunHistory({
  runs,
  ruleName,
  locale,
  t,
  onBack,
  onOpenIssue,
}: {
  runs: AutomationUiRun[];
  ruleName?: string;
  locale: string;
  t: Translate;
  onBack(): void;
  onOpenIssue?: (issueId: string) => void;
}) {
  return (
    <div
      className="automation-policy-runs"
      data-testid="automation-run-history"
    >
      <header>
        <button type="button" onClick={onBack}>
          <ChevronRight size={17} />
          {t("automation.policy.historyBack")}
        </button>
        <div>
          <h2>{t("automation.runs.title")}</h2>
          <p>
            {ruleName
              ? t("automation.policy.historyDescription", {
                  name: ruleName,
                })
              : t("automation.policy.historyAll")}
          </p>
        </div>
      </header>
      {runs.length ? (
        <div className="automation-policy-run-list">
          {runs.map((run) => (
            <article key={run.id} data-testid={`automation-run-${run.id}`}>
              <span className={`automation-policy-run-status is-${run.status}`}>
                {run.status === "running" ? (
                  <LoaderCircle className="automation-policy-spin" size={16} />
                ) : run.status === "succeeded" ? (
                  <Check size={16} />
                ) : (
                  <Clock3 size={16} />
                )}
              </span>
              <div>
                <strong>
                  {run.issue || t("automation.policy.unnamedIssue")}
                </strong>
                <p>
                  {t(`automation.policy.run.${run.status}`)} ·{" "}
                  {formatTime(run.triggeredAt, locale)}
                </p>
              </div>
              <span>{run.duration || "—"}</span>
              {run.issueId && onOpenIssue ? (
                <button
                  type="button"
                  data-testid={`automation-open-issue-${run.id}`}
                  onClick={() => onOpenIssue(run.issueId!)}
                >
                  {t("automation.policy.openIssue")}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="automation-policy-runs-empty">
          <History size={24} />
          <strong>{t("automation.policy.historyEmpty")}</strong>
          <p>{t("automation.policy.historyEmptyDescription")}</p>
        </div>
      )}
    </div>
  );
}
