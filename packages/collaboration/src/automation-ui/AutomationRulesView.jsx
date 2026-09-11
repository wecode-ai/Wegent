import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Clock3,
  Cloud,
  Code2,
  Copy,
  Flag,
  FolderKanban,
  GitBranch,
  History,
  Laptop,
  LayoutGrid,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Puzzle,
  Repeat,
  Search,
  Settings2,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
  Webhook,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import {
  HostEventSubscriptionPicker as EventSubscriptionPicker,
  PopupMenu,
  useTranslation,
} from "./AutomationUiHost";
import { AutomationWorkflowCanvas } from "./AutomationWorkflowCanvas";
import { automationClass } from "./automationStyles";
import { eventTypeLabel } from "./eventTypeLabel";
import {
  BRANCH_HANDLER_ROW_GAP,
  OUTER_NODE_GAP,
  OUTER_NODE_HEIGHT,
  OUTER_NODE_WIDTH,
  loopBodyNodeSize,
  stepCanvasSize,
} from "./canvasGeometry";

const ACTIVE_RUN_STATUSES = new Set([
  "pending",
  "queued",
  "waiting_runtime",
  "waiting_device",
  "running",
]);
const AUTO_SAVE_DELAY_MS = 600;
const EMPTY_EXECUTION_CATALOG = {
  environments: [],
  models: [],
  runtimeProfiles: [],
  plugins: [],
};
const AUTOMATION_PANEL_GAP = 12;
const AUTOMATION_RIGHT_PANEL_WIDTH = 400;
const AUTOMATION_RIGHT_PANEL_TOP = 64;
const DELIVERABLE_TYPE_KEYS = {
  text: "automation.deliverable.text",
  file: "automation.deliverable.file",
  code_snapshot: "automation.deliverable.codeSnapshot",
  git_branch: "automation.deliverable.gitBranch",
  pull_request: "automation.deliverable.pullRequest",
  url: "automation.deliverable.url",
};
const BRANCH_HANDLER_COLUMN_GAP = OUTER_NODE_WIDTH + OUTER_NODE_GAP; // matches addStep column spacing
const LOOP_BODY_HANDLER_COLUMN_GAP = 260; // matches loop body column spacing

function runMatchesFilter(status, filter) {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_RUN_STATUSES.has(status);
  if (filter === "success") return status === "succeeded";
  if (filter === "failed") return status === "failed" || status === "cancelled";
  return false;
}

function runStatusPresentation(status, t) {
  const presentations = {
    pending: {
      label: t("automation.status.pending"),
      tone: "queued",
      icon: Clock3,
    },
    queued: {
      label: t("automation.status.queued"),
      tone: "queued",
      icon: Clock3,
    },
    waiting_runtime: {
      label: t("automation.status.waitingRuntime"),
      tone: "waiting",
      icon: Clock3,
    },
    waiting_device: {
      label: t("automation.status.waitingDevice"),
      tone: "waiting",
      icon: Clock3,
    },
    running: {
      label: t("automation.status.running"),
      tone: "running",
      icon: Activity,
    },
    succeeded: {
      label: t("automation.status.succeeded"),
      tone: "success",
      icon: CheckCircle2,
    },
    failed: {
      label: t("automation.status.failed"),
      tone: "failed",
      icon: XCircle,
    },
    skipped: {
      label: t("automation.status.skipped"),
      tone: "neutral",
      icon: Circle,
    },
    cancelled: {
      label: t("automation.status.cancelled"),
      tone: "failed",
      icon: XCircle,
    },
  };
  return presentations[status] ?? presentations.pending;
}

function createExecutionNode({
  id,
  name,
  prompt,
  kind = "task",
  dependencies = [],
  dependencyContext = {},
  x = 0,
  y = 0,
  deliverables = [],
  executionMode = "automatic",
  environment = "",
  executionEnvironment = "local",
  executionDeviceId = null,
  runtimeProfileId = null,
  model = "",
  modelType = null,
  modelOptions = {},
  plugins = [],
  projectPlugins = [],
  workspacePolicy = executionMode === "automatic" ? "none" : "composer",
  required = true,
  automationRuleId = null,
  executionConfig = null,
  executionConfigOverride = false,
  approvalPolicy = undefined,
  subgraph = null,
  nodeType = "task",
  role = null,
  loopId = null,
  bodyNodeIds = [],
  loopConfig = null,
  branchConditions = [],
  eventWait = null,
}) {
  return {
    id,
    name,
    prompt,
    kind,
    dependencies,
    dependencyContext,
    x,
    y,
    deliverables,
    executionMode,
    environment,
    executionEnvironment,
    executionDeviceId,
    runtimeProfileId,
    model,
    modelType,
    modelOptions,
    plugins,
    projectPlugins,
    workspacePolicy,
    required,
    automationRuleId,
    executionConfig,
    executionConfigOverride,
    approvalPolicy,
    subgraph,
    nodeType,
    role,
    loopId,
    bodyNodeIds,
    loopConfig,
    branchConditions,
    eventWait,
  };
}

function defaultExecutionConfiguration(executionCatalog) {
  const environment = executionCatalog.environments[0];
  const model = executionCatalog.models[0];
  return {
    environment: environment?.label ?? "",
    executionEnvironment: environment?.executionEnvironment ?? "local",
    executionDeviceId: environment?.deviceId ?? null,
    runtimeProfileId: null,
    model: model?.name ?? "",
    modelType: model?.type ?? null,
    modelOptions: model?.options ?? {},
  };
}

function environmentDisplayLabel(option, t) {
  if (!option) return "";
  if (option.executionEnvironment === "local")
    return t("automation.execution.local");
  return option.label.replace(/\s*·\s*(在线|忙碌)$/, "") || option.deviceId;
}

function clearExecutionEnvironment(onChange) {
  onChange("executionDeviceId", null);
  onChange("executionEnvironment", "local");
  onChange("environment", "");
  onChange("runtimeProfileId", null);
}

function clearExecutionModel(onChange) {
  onChange("model", "");
  onChange("modelType", null);
  onChange("modelOptions", {});
  onChange("runtimeProfileId", null);
}

function ExecutionEnvironmentSelect({ testId, value, options, onChange }) {
  const { t } = useTranslation("common");
  const selected = options.find((option) => option.deviceId === value);
  const selectedLabel = environmentDisplayLabel(selected, t);
  const SelectedIcon =
    selected?.executionEnvironment === "cloud" ? Cloud : Laptop;

  return (
    <PopupMenu
      testId={testId}
      fullWidth
      trigger={
        <span
          data-value={value ?? ""}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-transparent bg-muted/60 px-3 text-sm text-text-primary transition-colors hover:bg-muted"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <SelectedIcon
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-text-secondary"
              />
            ) : null}
            <span
              className={selected ? "truncate" : "truncate text-text-muted"}
            >
              {selectedLabel || t("automation.execution.select")}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-text-secondary"
          />
        </span>
      }
    >
      {(close) => (
        <>
          <button
            type="button"
            data-testid={`${testId}-option-none`}
            onClick={() => {
              onChange(null);
              close();
            }}
            className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-text-primary hover:bg-surface"
          >
            <X
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-text-secondary"
            />
            <span className="min-w-0 flex-1 truncate">
              {t("automation.execution.none")}
            </span>
            {!value ? <Check className="h-4 w-4 shrink-0" /> : null}
          </button>
          {options.map((option) => {
            const label = environmentDisplayLabel(option, t);
            const OptionIcon =
              option.executionEnvironment === "cloud" ? Cloud : Laptop;
            return (
              <button
                key={option.deviceId}
                type="button"
                data-testid={`${testId}-option-${option.deviceId}`}
                aria-label={
                  option.executionEnvironment === "cloud"
                    ? t("automation.execution.cloud", { name: label })
                    : t("automation.execution.local")
                }
                onClick={() => {
                  onChange(option.deviceId);
                  close();
                }}
                className="flex h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium text-text-primary hover:bg-surface"
              >
                <OptionIcon
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-text-secondary"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {option.deviceId === value ? (
                  <Check className="h-4 w-4 shrink-0" />
                ) : null}
              </button>
            );
          })}
        </>
      )}
    </PopupMenu>
  );
}

function createDynamicAllocationNode(
  executionCatalog,
  id = `step-${Date.now()}`,
  t,
) {
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    kind: "dynamic",
    name: t("automation.node.dynamic"),
    prompt: t("automation.editor.dynamicDefaultPrompt"),
    approvalPolicy: "required",
    subgraph: {
      nodes: [],
    },
  });
}

function createLoopNode(id = `loop-${Date.now()}`, t) {
  const bodyId = `loop-start-${Date.now()}`;
  return createExecutionNode({
    id,
    kind: "loop",
    name: t("automation.node.loop"),
    prompt: "",
    dependencies: [],
    dependencyContext: {},
    executionMode: "manual",
    workspacePolicy: "none",
    nodeType: "loop",
    bodyNodeIds: [bodyId],
    loopConfig: {
      maxAttempts: 5,
      timeoutSeconds: null,
    },
    subgraph: {
      nodes: [
        createExecutionNode({
          id: bodyId,
          name: t("automation.node.loopStart"),
          kind: "task",
          nodeType: "loopStart",
          executionMode: "manual",
          workspacePolicy: "none",
          dependencies: [],
          dependencyContext: {},
          x: 0,
          y: 0,
        }),
      ],
    },
  });
}

function createLoopBodyNode(executionCatalog, loopId, kind, t) {
  const id = `loop-body-${Date.now()}`;
  if (kind === "branch") {
    return createExecutionNode({
      id,
      name: t("automation.node.branch"),
      kind: "task",
      nodeType: "branch",
      loopId,
      executionMode: "manual",
      workspacePolicy: "none",
      dependencies: [],
      dependencyContext: {},
      x: 240,
      y: 0,
      branchConditions: [],
      eventWait: {
        collectionMode: "poll",
        subscriptionId: null,
        pollIntervalSeconds: 300,
      },
    });
  }
  if (kind === "loopEnd") {
    return createExecutionNode({
      id,
      name: t("automation.node.loopEnd"),
      kind: "task",
      nodeType: "loopEnd",
      loopId,
      executionMode: "manual",
      workspacePolicy: "none",
      dependencies: [],
      dependencyContext: {},
      x: 240,
      y: 90,
    });
  }
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    name: "",
    prompt: "",
    kind: "task",
    nodeType: "task",
    loopId,
    dependencies: [],
    dependencyContext: {},
    x: 240,
    y: 90,
  });
}

function createBranchNode(id = `branch-${Date.now()}`, t) {
  return createExecutionNode({
    id,
    kind: "branch",
    name: t("automation.node.branch"),
    prompt: "",
    dependencies: [],
    dependencyContext: {},
    executionMode: "manual",
    workspacePolicy: "none",
    nodeType: "branch",
    branchConditions: [],
    eventWait: {
      collectionMode: "poll",
      subscriptionId: null,
      pollIntervalSeconds: 300,
    },
  });
}

function createBranchHandlerNode(executionCatalog, kind, id, t) {
  if (kind === "dynamic")
    return createDynamicAllocationNode(executionCatalog, id, t);
  if (kind === "loop") return createLoopNode(id, t);
  if (kind === "branch") return createBranchNode(id, t);
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    name: "",
    prompt: "",
  });
}

function createLoopBranchHandlerNode(executionCatalog, loopId, kind, t) {
  if (kind === "branch")
    return createLoopBodyNode(executionCatalog, loopId, "branch", t);
  if (kind === "loopEnd")
    return createLoopBodyNode(executionCatalog, loopId, "loopEnd", t);
  return createLoopBodyNode(executionCatalog, loopId, "task", t);
}

function insertStepAfter(
  container,
  anchorId,
  node,
  {
    gap,
    condition = null,
    alignY = null,
    stack = false,
    nodeSize = stepCanvasSize,
  },
) {
  const branchIndex = container.findIndex(
    (candidate) => candidate.id === anchorId,
  );
  if (branchIndex < 0) return null;
  const anchor = container[branchIndex];
  const nodeId = node.id;
  const insertionX = (anchor.x ?? 0) + gap;
  // Condition handlers already added to this branch stay in the handler column
  // so new handlers stack downward instead of pushing the column to the right.
  const handlerIds = new Set(
    (anchor.branchConditions ?? []).flatMap(
      (condition) => condition.handlerNodeIds ?? [],
    ),
  );
  let insertionY;
  if (alignY != null) {
    insertionY = alignY;
  } else if (stack) {
    const stackedHandlers = container.filter((candidate) =>
      handlerIds.has(candidate.id),
    );
    if (stackedHandlers.length > 0) {
      const bottomY = Math.max(
        ...stackedHandlers.map(
          (candidate) => (candidate.y ?? 0) + nodeSize(candidate).height,
        ),
      );
      insertionY = bottomY + BRANCH_HANDLER_ROW_GAP;
    } else {
      insertionY = anchor.y ?? 0;
    }
  } else {
    insertionY = anchor.y ?? 0;
  }
  const inserted = {
    ...node,
    x: insertionX,
    y: insertionY,
    dependencies: [anchorId],
    dependencyContext: { [anchorId]: ["final_result", "deliveries"] },
  };
  const next = [];
  container.forEach((node, index) => {
    let value = node;
    if (!stack || !handlerIds.has(node.id)) {
      if (node.x >= insertionX) value = { ...value, x: value.x + gap };
    }
    if (node.id === anchorId && condition) {
      value = {
        ...value,
        branchConditions: [
          ...(value.branchConditions ?? []),
          { ...condition, handlerNodeIds: [nodeId] },
        ],
      };
    }
    next.push(value);
    if (index === branchIndex) next.push(inserted);
  });
  return { container: next, nodeId };
}

function findBranchOwner(steps, branchId) {
  const topStep = steps.find(
    (step) => step.id === branchId && step.kind === "branch",
  );
  if (topStep) return { type: "top", step: topStep };
  const loopStep = steps.find(
    (step) =>
      step.kind === "loop" &&
      (step.subgraph?.nodes ?? []).some(
        (node) => node.id === branchId && node.nodeType === "branch",
      ),
  );
  if (loopStep) return { type: "loop", step: loopStep };
  return null;
}

function createStageConstraint(overrides) {
  return createExecutionNode({
    id: overrides.id,
    name: overrides.name,
    prompt: overrides.prompt,
    dependencies: overrides.dependencies ?? [],
    dependencyContext: overrides.dependencyContext ?? {},
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    deliverables: overrides.deliverables ?? [],
    executionMode: overrides.executionMode ?? "automatic",
    workspacePolicy: "none",
    required: overrides.required ?? true,
    automationRuleId: overrides.automationRuleId ?? null,
  });
}

const automationTemplates = (t) => [
  {
    id: "issue-development",
    category: "issue",
    featured: true,
    name: t("automation.template.development.name"),
    description: t("automation.template.development.description"),
    tags: ["Issue", t("automation.template.development.tag")],
    icon: "development",
    trigger: {
      type: "event",
      source: "wework",
      collectionMode: "webhook",
      startMode: "immediate",
      event: "created",
      tags: [t("automation.template.development.triggerTag")],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "03:00",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [
      {
        name: t("automation.template.development.analyze"),
        prompt: t("automation.template.development.analyzePrompt"),
        deliverables: [
          {
            name: t("automation.template.development.analysisDeliverable"),
            description: t(
              "automation.template.development.analysisDescription",
            ),
            valueType: "text",
          },
        ],
        plugins: [t("automation.template.plugin.projectSpace")],
      },
      {
        name: t("automation.template.development.implement"),
        prompt: t("automation.template.development.implementPrompt"),
        deliverables: [
          {
            name: t("automation.template.development.resultDeliverable"),
            description: t("automation.template.development.resultDescription"),
            valueType: "text",
          },
        ],
        plugins: ["GitHub", t("automation.template.plugin.projectSpace")],
        workspacePolicy: "inherit",
      },
      {
        name: t("automation.template.development.writeBack"),
        prompt: t("automation.template.development.writeBackPrompt"),
        deliverables: [
          {
            name: t("automation.template.development.updateDeliverable"),
            description: t("automation.template.development.updateDescription"),
            valueType: "text",
          },
        ],
        plugins: [t("automation.template.plugin.projectSpace")],
        workspacePolicy: "inherit",
      },
    ],
  },
  {
    id: "issue-testing",
    category: "issue",
    featured: true,
    name: t("automation.template.testing.name"),
    description: t("automation.template.testing.description"),
    tags: ["Issue", t("automation.template.testing.tag")],
    icon: "testing",
    trigger: {
      type: "event",
      source: "wework",
      startMode: "immediate",
      event: "created",
      tags: [t("automation.template.testing.triggerTag")],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "03:00",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [
      {
        name: t("automation.template.testing.scope"),
        prompt: t("automation.template.testing.scopePrompt"),
        plugins: ["GitHub", t("automation.template.plugin.projectSpace")],
      },
      {
        name: t("automation.template.testing.run"),
        prompt: t("automation.template.testing.runPrompt"),
        plugins: ["GitHub"],
        workspacePolicy: "inherit",
      },
      {
        name: t("automation.template.testing.update"),
        prompt: t("automation.template.testing.updatePrompt"),
        plugins: [t("automation.template.plugin.projectSpace")],
        workspacePolicy: "inherit",
      },
    ],
  },
  {
    id: "daily-inspection",
    category: "schedule",
    featured: true,
    name: t("automation.template.inspection.name"),
    description: t("automation.template.inspection.description"),
    tags: [
      t("automation.template.inspection.scheduleTag"),
      t("automation.template.inspection.tag"),
    ],
    icon: "schedule",
    trigger: {
      type: "schedule",
      source: "wework",
      startMode: "immediate",
      event: "created",
      tags: [],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "09:30",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [
      {
        name: t("automation.template.inspection.check"),
        prompt: t("automation.template.inspection.checkPrompt"),
      },
      {
        name: t("automation.template.inspection.report"),
        prompt: t("automation.template.inspection.reportPrompt"),
        workspacePolicy: "inherit",
      },
    ],
  },
  {
    id: "issue-defect-triage",
    category: "issue",
    featured: false,
    name: t("automation.template.defect.name"),
    description: t("automation.template.defect.description"),
    tags: ["Issue", t("automation.template.defect.tag")],
    icon: "defect",
    trigger: {
      type: "event",
      source: "wework",
      startMode: "status",
      event: "created",
      tags: [t("automation.template.defect.tag")],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "03:00",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [
      {
        name: t("automation.template.defect.reproduce"),
        prompt: t("automation.template.defect.reproducePrompt"),
        plugins: ["GitHub", t("automation.template.plugin.projectSpace")],
      },
      {
        name: t("automation.template.defect.locate"),
        prompt: t("automation.template.defect.locatePrompt"),
        plugins: ["GitHub"],
        workspacePolicy: "inherit",
      },
      {
        name: t("automation.template.defect.suggest"),
        prompt: t("automation.template.defect.suggestPrompt"),
        plugins: [t("automation.template.plugin.projectSpace")],
        workspacePolicy: "inherit",
      },
    ],
  },
];

function triggerPresentation(trigger, t) {
  const frequencyLabels = {
    daily: t("automation.trigger.daily"),
    weekdays: t("automation.trigger.weekdays"),
    weekly: t("automation.trigger.weekly"),
  };
  const weekdayLabels = {
    monday: t("automation.trigger.monday"),
    tuesday: t("automation.trigger.tuesday"),
    wednesday: t("automation.trigger.wednesday"),
    thursday: t("automation.trigger.thursday"),
    friday: t("automation.trigger.friday"),
    saturday: t("automation.trigger.saturday"),
    sunday: t("automation.trigger.sunday"),
  };
  if (trigger.type === "schedule") {
    const schedule = trigger.schedule;
    const frequency =
      schedule.frequency === "weekly"
        ? t("automation.trigger.weeklyOn", {
            weekday: weekdayLabels[schedule.weekday],
          })
        : frequencyLabels[schedule.frequency];
    return {
      label:
        schedule.frequency === "hourly"
          ? t("workbench.board_automation_hourly_summary", {
              minute: Number(schedule.time.split(":")[1]),
            })
          : `${frequency} ${schedule.time}`,
      detail: t("automation.trigger.scheduleDetail", {
        timezone: schedule.timezone,
      }),
    };
  }

  if (trigger.source !== "wework") {
    return {
      label: eventTypeLabel(trigger.event, t),
      detail: trigger.subscriptionId
        ? t("automation.trigger.subscription", { id: trigger.subscriptionId })
        : t("automation.trigger.selectSubscription"),
    };
  }

  if (trigger.startMode === "status") {
    return {
      label: t("automation.trigger.issueStarted"),
      detail: t("automation.trigger.issueStartedDetail"),
    };
  }

  const tagSuffix = trigger.tags.length
    ? t("automation.trigger.tagSuffix", { tags: trigger.tags.join("、") })
    : "";
  return {
    label: t("automation.trigger.issueCreated"),
    detail: t("automation.trigger.issueCreatedDetail", { tags: tagSuffix }),
  };
}

function cloneRule(rule) {
  const cloneNode = (step) => ({
    ...step,
    dependencies: [...(step.dependencies ?? [])],
    dependencyContext: Object.fromEntries(
      Object.entries(step.dependencyContext ?? {}).map(
        ([dependencyId, sources]) => [dependencyId, [...sources]],
      ),
    ),
    deliverables: step.deliverables.map((deliverable) => ({ ...deliverable })),
    plugins: [...step.plugins],
    projectPlugins: [...(step.projectPlugins ?? [])],
    modelOptions: { ...(step.modelOptions ?? {}) },
    executionConfig: step.executionConfig
      ? {
          ...step.executionConfig,
          model_options: { ...(step.executionConfig.model_options ?? {}) },
          project_plugins: [...(step.executionConfig.project_plugins ?? [])],
        }
      : null,
    subgraph: step.subgraph
      ? {
          nodes: step.subgraph.nodes.map(cloneNode),
        }
      : null,
  });
  return {
    ...rule,
    trigger: {
      ...rule.trigger,
      tags: [...rule.trigger.tags],
      schedule: { ...rule.trigger.schedule },
    },
    steps: rule.steps.map(cloneNode),
  };
}

function validateRule(rule, t) {
  if (!rule.name.trim()) return t("automation.validation.name");

  const hasUnnamedNode = (nodes) =>
    nodes.some(
      (node) =>
        !node.name.trim() ||
        ((node.kind === "dynamic" || node.kind === "loop") &&
          hasUnnamedNode(node.subgraph?.nodes ?? [])),
    );
  if (hasUnnamedNode(rule.steps)) return t("automation.validation.nodeNames");

  const hasInvalidBranchCondition = (nodes) =>
    nodes.some(
      (node) =>
        (node.branchConditions ?? []).some(
          (condition) => !(condition.eventType ?? "").trim(),
        ) || hasInvalidBranchCondition(node.subgraph?.nodes ?? []),
    );
  if (hasInvalidBranchCondition(rule.steps))
    return t("automation.validation.branchEvent");

  const hasDuplicateBranchCondition = (nodes) =>
    nodes.some((node) => {
      const conditionKeys = new Set();
      const duplicated = (node.branchConditions ?? []).some((condition) => {
        const key = `${condition.sourceType ?? "github"}:${condition.eventType ?? ""}`;
        if (conditionKeys.has(key)) return true;
        conditionKeys.add(key);
        return false;
      });
      return (
        duplicated || hasDuplicateBranchCondition(node.subgraph?.nodes ?? [])
      );
    });
  return hasDuplicateBranchCondition(rule.steps)
    ? t("automation.validation.duplicateBranch")
    : "";
}

function mergeSavedIdentity(rule, saved) {
  return {
    ...rule,
    id: saved.id,
    persisted: saved.persisted,
    origin: saved.origin,
    version: saved.version,
    updatedAt: saved.updatedAt,
    nextRunAt: saved.nextRunAt,
    lastRunAt: saved.lastRunAt,
    lastRunStatus: saved.lastRunStatus,
    legacyDefinition: saved.legacyDefinition,
  };
}

function makeRule(t) {
  return {
    id: `draft-${crypto.randomUUID()}`,
    persisted: false,
    origin: "automation",
    version: 1,
    name: t("automation.rule.unnamed"),
    description: "",
    enabled: true,
    updatedAt: t("automation.rule.neverSaved"),
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: "event",
      source: "wework",
      startMode: "immediate",
      event: "created",
      tags: [],
      schedule: {
        frequency: "daily",
        weekday: "monday",
        time: "03:00",
        timezone: "Asia/Shanghai",
      },
    },
    steps: [],
    legacyDefinition: null,
  };
}

function makeRuleFromTemplate(template, executionCatalog, t) {
  const createdAt = Date.now();
  const rule = makeRule(t);
  const executionDefaults = defaultExecutionConfiguration(executionCatalog);
  return {
    ...rule,
    name: template.name,
    description: template.description,
    trigger: {
      ...template.trigger,
      tags: [...template.trigger.tags],
      schedule: { ...template.trigger.schedule },
    },
    steps: template.steps.map((step, stepIndex) =>
      createExecutionNode({
        ...executionDefaults,
        ...step,
        id: `step-${createdAt}-${stepIndex + 1}`,
        dependencies: stepIndex ? [`step-${createdAt}-${stepIndex}`] : [],
        x: 440 + stepIndex * 420,
        y: 226,
        deliverables: (step.deliverables ?? []).map(
          (deliverable, deliverableIndex) => ({
            ...deliverable,
            id: `deliverable-${createdAt}-${stepIndex + 1}-${deliverableIndex + 1}`,
          }),
        ),
        plugins: [...(step.plugins ?? [])],
      }),
    ),
  };
}

export function AutomationRulesView({
  rules: backendRules,
  runs: backendRuns,
  loading = false,
  error = "",
  canManage = true,
  projectTags = [],
  eventSourceCatalog = [],
  projectIncomingHookApi,
  projectId,
  project,
  executionCatalog: initialExecutionCatalog = EMPTY_EXECUTION_CATALOG,
  onReload,
  onLoadExecutionCatalog,
  onLoadExecutionPlugins,
  onLoadRuns,
  onRunRule,
  onSaveRule,
  onToggleRule,
  onDuplicateRule,
  onDeleteRule,
}) {
  const { t } = useTranslation("common");
  const runningRef = useRef(new Set());
  const [runningIds, setRunningIds] = useState(new Set());
  const runRule = async (rule) => {
    if (
      !onRunRule ||
      !canManage ||
      !rule.persisted ||
      runningRef.current.has(rule.id)
    )
      return;
    runningRef.current.add(rule.id);
    setRunningIds(new Set(runningRef.current));
    try {
      await onRunRule(rule);
      notify(t("workbench.board_automation_run_started"));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    } finally {
      runningRef.current.delete(rule.id);
      setRunningIds(new Set(runningRef.current));
    }
  };
  const [view, setView] = useState("home");
  const [homeTab, setHomeTab] = useState("rules");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [rules, setRules] = useState(backendRules);
  const [runs, setRuns] = useState(backendRuns);
  const [executionCatalog, setExecutionCatalog] = useState(
    initialExecutionCatalog,
  );
  const [draft, setDraft] = useState(() => makeRule(t));
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [editorSection, setEditorSection] = useState("workflow");
  const [selectedNode, setSelectedNode] = useState({ type: "trigger" });
  const [panelTab, setPanelTab] = useState("settings");
  const [templateStoreOpen, setTemplateStoreOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [saveState, setSaveState] = useState("saved");
  const [saveError, setSaveError] = useState("");
  const [runsLoading, setRunsLoading] = useState(false);
  const draftRef = useRef(draft);
  const savedSnapshotRef = useRef("");
  const saveTimerRef = useRef(null);
  const saveRequestRef = useRef(null);
  const flushAutoSaveRef = useRef(null);
  const failedSnapshotRef = useRef("");
  const leavingEditorRef = useRef(false);
  const executionCatalogRequestRef = useRef(null);
  const executionPluginRequestRef = useRef(null);
  const runsRequestRef = useRef(null);
  const pollingSubscriptionRef = useRef(null);
  const toastTimerRef = useRef(null);

  const dirty = JSON.stringify(draft) !== savedSnapshot;

  useEffect(() => {
    setRules(backendRules);
  }, [backendRules]);

  useEffect(() => {
    if (!draft.persisted || JSON.stringify(draft) !== savedSnapshot) return;
    const refreshed = backendRules.find((rule) => rule.id === draft.id);
    if (!refreshed) return;
    if (refreshed.version <= draft.version) return;
    const refreshedSnapshot = JSON.stringify(refreshed);
    if (refreshedSnapshot === savedSnapshot) return;
    const nextDraft = cloneRule(refreshed);
    draftRef.current = nextDraft;
    savedSnapshotRef.current = refreshedSnapshot;
    setDraft(nextDraft);
    setSavedSnapshot(refreshedSnapshot);
    setSaveState("saved");
  }, [backendRules, draft, savedSnapshot]);

  useEffect(() => {
    setRuns(backendRuns);
  }, [backendRuns]);

  useEffect(() => {
    setExecutionCatalog(initialExecutionCatalog);
  }, [initialExecutionCatalog]);

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    },
    [],
  );

  const visibleRules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return rules.filter((rule) => {
      const matchesStatus =
        filter === "all" ||
        (filter === "enabled" ? rule.enabled : !rule.enabled);
      const trigger = triggerPresentation(rule.trigger, t);
      const matchesQuery =
        !normalized ||
        `${rule.name} ${rule.description} ${trigger.label}`
          .toLowerCase()
          .includes(normalized);
      return matchesStatus && matchesQuery;
    });
  }, [filter, query, rules, t]);

  const notify = (message) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast("");
    }, 2200);
  };

  const loadExecutionCatalog = async () => {
    if (!onLoadExecutionCatalog) return executionCatalog;
    if (!executionCatalogRequestRef.current) {
      executionCatalogRequestRef.current = onLoadExecutionCatalog()
        .then((catalog) => {
          setExecutionCatalog((current) => ({
            ...catalog,
            plugins: current.plugins,
          }));
          return catalog;
        })
        .finally(() => {
          executionCatalogRequestRef.current = null;
        });
    }
    return executionCatalogRequestRef.current;
  };

  const refreshExecutionCatalog = () => {
    void loadExecutionCatalog().catch((loadError) => {
      notify(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    });
  };

  const loadExecutionPlugins = async () => {
    if (!onLoadExecutionPlugins) return executionCatalog.plugins;
    if (!executionPluginRequestRef.current) {
      executionPluginRequestRef.current = onLoadExecutionPlugins(
        executionCatalog.environments.map(
          (environment) => environment.deviceId,
        ),
      )
        .then((plugins) => {
          setExecutionCatalog((current) => ({ ...current, plugins }));
          return plugins;
        })
        .finally(() => {
          executionPluginRequestRef.current = null;
        });
    }
    return executionPluginRequestRef.current;
  };

  const preparePluginMenu = () => {
    void loadExecutionPlugins().catch((loadError) => {
      notify(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    });
  };

  const openRule = (rule) => {
    const nextDraft = cloneRule(rule);
    const nextSnapshot = JSON.stringify(rule);
    draftRef.current = nextDraft;
    savedSnapshotRef.current = nextSnapshot;
    failedSnapshotRef.current = "";
    setDraft(nextDraft);
    setSavedSnapshot(nextSnapshot);
    setSaveState("saved");
    setSaveError("");
    setEditorSection("workflow");
    setSelectedNode({ type: "trigger" });
    setPanelTab("settings");
    setView("editor");
    refreshExecutionCatalog();
  };

  const createRule = () => {
    const rule = makeRule(t);
    const nextSnapshot = JSON.stringify(rule);
    draftRef.current = rule;
    savedSnapshotRef.current = nextSnapshot;
    failedSnapshotRef.current = "";
    setDraft(rule);
    setSavedSnapshot(nextSnapshot);
    setSaveState("pending");
    setSaveError("");
    setEditorSection("workflow");
    setSelectedNode({ type: "trigger" });
    setPanelTab("settings");
    setView("editor");
    refreshExecutionCatalog();
  };

  const ensureTriggerPollingSubscription = async (trigger) => {
    if (
      !projectIncomingHookApi ||
      !projectId ||
      trigger.collectionMode !== "poll" ||
      trigger.subscriptionId
    ) {
      return;
    }
    const repository = project?.provider_config?.repository?.trim();
    const domain = project?.provider_config?.domain?.trim();
    if (!repository || project?.task_provider !== trigger.source) return;
    const defaultDomain =
      trigger.source === "github" ? "github.com" : "gitlab.com";
    const resourceUrl = `https://${domain || defaultDomain}/${repository}`;
    try {
      const existing = (await projectIncomingHookApi.list(projectId)).find(
        (item) =>
          item.collectionMode === "poll" &&
          item.sourceType === trigger.source &&
          item.resource?.url === resourceUrl,
      );
      if (existing) {
        pollingSubscriptionRef.current = existing;
        updateDraft((current) =>
          current.trigger.subscriptionId === existing.id
            ? current
            : {
                ...current,
                trigger: { ...current.trigger, subscriptionId: existing.id },
              },
        );
        return;
      }
      const created = await projectIncomingHookApi.create(projectId, {
        name: t("automation.poll.subscriptionName", {
          project: project.name,
        }),
        sourceType: trigger.source,
        collectionMode: "poll",
        resource: { url: resourceUrl },
        pollIntervalSeconds: 300,
        credentialRef: "project-provider",
      });
      pollingSubscriptionRef.current = created;
      updateDraft((current) => ({
        ...current,
        trigger: { ...current.trigger, subscriptionId: created.id },
      }));
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };

  const applyTemplate = (template) => {
    const rule = makeRuleFromTemplate(template, executionCatalog, t);
    draftRef.current = rule;
    savedSnapshotRef.current = "";
    failedSnapshotRef.current = "";
    setTemplateStoreOpen(false);
    setDraft(rule);
    setSavedSnapshot("");
    setSaveState("pending");
    setSaveError("");
    setEditorSection("workflow");
    setSelectedNode({ type: "trigger" });
    setPanelTab("settings");
    setView("editor");
    refreshExecutionCatalog();
  };

  const loadRuns = async () => {
    if (!onLoadRuns) return runs;
    if (!runsRequestRef.current) {
      setRunsLoading(true);
      runsRequestRef.current = onLoadRuns()
        .then((loadedRuns) => {
          setRuns(loadedRuns);
          return loadedRuns;
        })
        .catch((loadError) => {
          notify(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
          throw loadError;
        })
        .finally(() => {
          setRunsLoading(false);
          runsRequestRef.current = null;
        });
    }
    return runsRequestRef.current;
  };

  const openRunsHome = () => {
    setHomeTab("runs");
    void loadRuns().catch(() => undefined);
  };

  const changeEditorSection = (section) => {
    setEditorSection(section);
    if (section === "runs") void loadRuns().catch(() => undefined);
  };

  const changePanelTab = (tab) => {
    setPanelTab(tab);
    if (tab === "lastRun") void loadRuns().catch(() => undefined);
  };

  const updateDraft = (updater) => {
    const nextDraft =
      typeof updater === "function" ? updater(draftRef.current) : updater;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  };

  const flushAutoSave = async ({ retryFailed = false } = {}) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (saveRequestRef.current) {
      return saveRequestRef.current;
    }

    const candidate = cloneRule(draftRef.current);
    const candidateSnapshot = JSON.stringify(candidate);
    if (candidateSnapshot === savedSnapshotRef.current) {
      setSaveState(candidate.persisted ? "saved" : "pending");
      return candidate;
    }

    const validationError = validateRule(candidate, t);
    if (validationError) {
      setSaveState("invalid");
      setSaveError(validationError);
      return null;
    }
    if (failedSnapshotRef.current === candidateSnapshot && !retryFailed) {
      setSaveState("error");
      return null;
    }

    failedSnapshotRef.current = "";
    setSaveState("saving");
    setSaveError("");
    const request = (async () => {
      try {
        const saved = onSaveRule ? await onSaveRule(candidate) : candidate;
        const nextSavedSnapshot = JSON.stringify(saved);
        savedSnapshotRef.current = nextSavedSnapshot;
        setSavedSnapshot(nextSavedSnapshot);
        setRules((current) => [
          saved,
          ...current.filter(
            (rule) => rule.id !== candidate.id && rule.id !== saved.id,
          ),
        ]);
        const currentDraft = draftRef.current;
        const nextDraft =
          JSON.stringify(currentDraft) === candidateSnapshot
            ? cloneRule(saved)
            : mergeSavedIdentity(currentDraft, saved);
        draftRef.current = nextDraft;
        setDraft(nextDraft);
        setSaveState(
          JSON.stringify(draftRef.current) === nextSavedSnapshot
            ? "saved"
            : "pending",
        );
        return saved;
      } catch (requestError) {
        failedSnapshotRef.current = candidateSnapshot;
        setSaveError(
          requestError instanceof Error
            ? requestError.message
            : String(requestError),
        );
        setSaveState("error");
        return null;
      } finally {
        saveRequestRef.current = null;
        const latestSnapshot = JSON.stringify(draftRef.current);
        const latestValidationError = validateRule(draftRef.current, t);
        const shouldContinue =
          latestSnapshot !== savedSnapshotRef.current &&
          latestSnapshot !== failedSnapshotRef.current &&
          !latestValidationError;
        if (shouldContinue) {
          setSaveState("pending");
          queueMicrotask(() => flushAutoSaveRef.current?.());
        } else if (latestValidationError) {
          setSaveError(latestValidationError);
          setSaveState("invalid");
        }
      }
    })();
    saveRequestRef.current = request;
    return request;
  };
  flushAutoSaveRef.current = flushAutoSave;

  useEffect(() => {
    if (view !== "editor") return undefined;
    const currentSnapshot = JSON.stringify(draft);
    if (currentSnapshot === savedSnapshot) {
      if (!saveRequestRef.current)
        setSaveState(draft.persisted ? "saved" : "pending");
      return undefined;
    }

    const validationError = validateRule(draft, t);
    if (validationError) {
      setSaveError(validationError);
      setSaveState("invalid");
      return undefined;
    }
    if (saveRequestRef.current) {
      return undefined;
    }
    if (failedSnapshotRef.current === currentSnapshot) {
      setSaveState("error");
      return undefined;
    }

    setSaveError("");
    setSaveState("pending");
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushAutoSaveRef.current?.();
    }, AUTO_SAVE_DELAY_MS);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [draft, savedSnapshot, view]);

  const leaveEditor = async () => {
    if (leavingEditorRef.current) return;
    leavingEditorRef.current = true;
    try {
      while (true) {
        if (saveRequestRef.current) await saveRequestRef.current;
        if (JSON.stringify(draftRef.current) === savedSnapshotRef.current)
          break;
        const validationError = validateRule(draftRef.current, t);
        if (validationError) {
          setSaveError(validationError);
          setSaveState("invalid");
          notify(validationError);
          return;
        }
        const saved = await flushAutoSaveRef.current?.({ retryFailed: true });
        if (!saved) return;
      }
      setView("home");
    } finally {
      leavingEditorRef.current = false;
    }
  };

  const retryAutoSave = () => {
    failedSnapshotRef.current = "";
    void flushAutoSaveRef.current?.({ retryFailed: true });
  };

  const duplicateRule = async (rule) => {
    try {
      const copy = onDuplicateRule
        ? await onDuplicateRule(rule)
        : {
            ...cloneRule(rule),
            id: `draft-${crypto.randomUUID()}`,
            persisted: false,
            origin: "automation",
            version: 1,
            name: t("automation.rule.copySuffix", { name: rule.name }),
            enabled: false,
          };
      setRules((current) => [
        copy,
        ...current.filter((item) => item.id !== copy.id),
      ]);
      notify(t("automation.rule.copyCreated"));
    } catch (duplicateError) {
      notify(
        duplicateError instanceof Error
          ? duplicateError.message
          : String(duplicateError),
      );
    }
  };

  const deleteRule = async (rule) => {
    try {
      await onDeleteRule?.(rule);
      setRules((current) => current.filter((item) => item.id !== rule.id));
      setRuns((current) => current.filter((run) => run.ruleId !== rule.id));
      notify(t("automation.rule.deleted"));
    } catch (deleteError) {
      notify(
        deleteError instanceof Error
          ? deleteError.message
          : String(deleteError),
      );
    }
  };

  const addStep = (anchorStepId, placement = "after", kind = "task") => {
    const step =
      kind === "dynamic"
        ? createDynamicAllocationNode(executionCatalog, undefined, t)
        : kind === "loop"
          ? createLoopNode(undefined, t)
          : kind === "branch"
            ? createBranchNode(undefined, t)
            : createExecutionNode({
                ...defaultExecutionConfiguration(executionCatalog),
                id: `step-${Date.now()}`,
                name: "",
                prompt: "",
              });
    updateDraft((current) => {
      const anchorIndex = anchorStepId
        ? current.steps.findIndex((candidate) => candidate.id === anchorStepId)
        : -1;
      const anchor = anchorIndex >= 0 ? current.steps[anchorIndex] : null;
      if (anchorStepId && !anchor) return current;
      if (placement === "before" && !anchor) return current;

      const anchorSize = anchor
        ? stepCanvasSize(anchor)
        : { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT };
      const stepSize = stepCanvasSize(step);
      const insertionX =
        placement === "before"
          ? (anchor?.x ?? 440)
          : anchor
            ? anchor.x + anchorSize.width + OUTER_NODE_GAP
            : 440;
      const insertionY = anchor?.y ?? 226;
      const shift = Math.max(
        OUTER_NODE_WIDTH + OUTER_NODE_GAP,
        stepSize.width + OUTER_NODE_GAP,
      );
      const shifted = current.steps.map((candidate) =>
        candidate.id !== anchor?.id && candidate.x >= insertionX
          ? { ...candidate, x: candidate.x + shift }
          : candidate,
      );
      const inheritedDependencies =
        placement === "before"
          ? [...anchor.dependencies]
          : anchor
            ? [anchor.id]
            : [];
      const inserted = {
        ...step,
        dependencies: inheritedDependencies,
        dependencyContext:
          placement === "before"
            ? { ...(anchor.dependencyContext ?? {}) }
            : Object.fromEntries(
                inheritedDependencies.map((dependencyId) => [
                  dependencyId,
                  ["final_result", "deliveries"],
                ]),
              ),
        x: insertionX,
        y: insertionY,
      };
      const rewired = shifted.map((candidate) => {
        if (placement === "before" && candidate.id === anchor.id) {
          return {
            ...candidate,
            x: candidate.x + 420,
            dependencies: [inserted.id],
            dependencyContext: {
              [inserted.id]: ["final_result", "deliveries"],
            },
          };
        }

        const followsAnchor = anchor
          ? candidate.dependencies.includes(anchor.id)
          : candidate.dependencies.length === 0;
        if (placement !== "after" || !followsAnchor) return candidate;
        const inheritedContext = anchor
          ? (candidate.dependencyContext?.[anchor.id] ?? [
              "final_result",
              "deliveries",
            ])
          : ["final_result", "deliveries"];
        return {
          ...candidate,
          dependencies: anchor
            ? candidate.dependencies.map((dependencyId) =>
                dependencyId === anchor.id ? inserted.id : dependencyId,
              )
            : [inserted.id],
          dependencyContext: {
            ...Object.fromEntries(
              Object.entries(candidate.dependencyContext ?? {}).filter(
                ([dependencyId]) => dependencyId !== anchor?.id,
              ),
            ),
            [inserted.id]: inheritedContext,
          },
        };
      });
      const next = [...rewired];
      next.splice(
        placement === "before" ? anchorIndex : anchorIndex + 1,
        0,
        inserted,
      );
      return { ...current, steps: next };
    });
    setSelectedNode({ type: "step", id: step.id });
  };

  const removeStep = (stepId = selectedNode.id) => {
    if (!stepId) return;
    updateDraft((current) => {
      const removed = current.steps.find((step) => step.id === stepId);
      if (!removed) return current;
      return {
        ...current,
        steps: current.steps
          .filter((step) => step.id !== stepId)
          .map((step) => {
            const cleanedConditions = (step.branchConditions ?? [])
              .map((condition) => ({
                ...condition,
                handlerNodeIds: condition.handlerNodeIds.filter(
                  (id) => id !== stepId,
                ),
              }))
              .filter((condition) => condition.handlerNodeIds.length > 0);
            if (!step.dependencies.includes(stepId)) {
              return { ...step, branchConditions: cleanedConditions };
            }
            const dependencies = Array.from(
              new Set([
                ...step.dependencies.filter(
                  (dependencyId) => dependencyId !== stepId,
                ),
                ...removed.dependencies,
              ]),
            );
            return {
              ...step,
              dependencies,
              branchConditions: cleanedConditions,
              dependencyContext: Object.fromEntries(
                dependencies.map((dependencyId) => [
                  dependencyId,
                  step.dependencyContext[dependencyId] ??
                    removed.dependencyContext[dependencyId] ?? [
                      "final_result",
                      "deliveries",
                    ],
                ]),
              ),
            };
          }),
      };
    });
    setSelectedNode({ type: "trigger" });
  };

  if (view === "editor") {
    const editor = (
      <div className={automationClass("project-editor-host")}>
        <WorkflowEditor
          draft={draft}
          runs={runs.filter((run) => run.ruleId === draft.id)}
          runsLoading={runsLoading}
          dirty={dirty}
          saveState={saveState}
          saveError={saveError}
          editorSection={editorSection}
          selectedNode={selectedNode}
          panelTab={panelTab}
          canManage={canManage}
          canRun={canManage && Boolean(onRunRule)}
          running={runningIds.has(draft.id)}
          onRun={() => runRule(draft)}
          projectTags={projectTags}
          eventSourceCatalog={eventSourceCatalog}
          projectIncomingHookApi={projectIncomingHookApi}
          projectId={projectId}
          executionCatalog={executionCatalog}
          onBack={leaveEditor}
          onEditorSectionChange={changeEditorSection}
          onSelectNode={setSelectedNode}
          onPanelTabChange={changePanelTab}
          onDraftChange={updateDraft}
          onRetrySave={retryAutoSave}
          onAddStep={addStep}
          onRemoveStep={removeStep}
          onOpenPluginMenu={preparePluginMenu}
          onTriggerCollectionModeChange={() =>
            void ensureTriggerPollingSubscription(draftRef.current.trigger)
          }
        />
      </div>
    );
    return (
      <div
        className={automationClass("automation-root editor")}
        data-testid="project-automation-view"
      >
        {editor}
        {toast ? (
          <div className={automationClass("toast")}>
            <CheckCircle2 size={16} />
            {toast}
          </div>
        ) : null}
      </div>
    );
  }

  const content = (
    <main className={automationClass("project-content")}>
      <div className={automationClass("project-page-title")}>
        <div>
          <h1>
            {homeTab === "rules"
              ? t("automation.title")
              : t("automation.runs.title")}
          </h1>
          <p>
            {homeTab === "rules"
              ? t("automation.home.description")
              : t("automation.runs.description")}
          </p>
        </div>
        {homeTab === "rules" ? (
          <div className={automationClass("project-page-actions")}>
            <button
              className={automationClass("project-secondary-action")}
              data-testid="automation-open-runs"
              onClick={openRunsHome}
            >
              <History size={15} />
              {t("automation.runs.open")}
            </button>
            <button
              className={automationClass("project-primary-action")}
              data-testid="automation-create-rule"
              disabled={!canManage}
              onClick={() => createRule()}
            >
              <Plus size={15} />
              {t("automation.create")}
            </button>
          </div>
        ) : null}
      </div>

      {homeTab === "rules" ? (
        <section className={automationClass("automation-home")}>
          <div className={automationClass("home-toolbar")}>
            <div className={automationClass("filter-tabs")}>
              {[
                ["all", t("automation.filter.all")],
                ["enabled", t("automation.filter.enabled")],
                ["paused", t("automation.filter.paused")],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? (
                    <LayoutGrid size={15} />
                  ) : (
                    <Circle size={13} />
                  )}
                  {label}
                </button>
              ))}
            </div>
            <div className={automationClass("toolbar-actions")}>
              <button className={automationClass("quiet-filter")}>
                <Tag size={15} />
                {t("automation.filter.allTags")}
                <ChevronDown size={14} />
              </button>
              <label className={automationClass("home-search")}>
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("automation.search")}
                />
                {query ? (
                  <button
                    onClick={() => setQuery("")}
                    aria-label={t("automation.search.clear")}
                  >
                    <X size={13} />
                  </button>
                ) : null}
              </label>
            </div>
          </div>

          <section className={automationClass("automation-grid")}>
            <div className={automationClass("create-card")}>
              <h2>{t("automation.create.title")}</h2>
              <button
                data-testid="automation-create-blank"
                onClick={() => createRule()}
              >
                <Plus size={18} />
                <span>
                  <strong>{t("automation.create.blank")}</strong>
                  <small>{t("automation.create.blankHint")}</small>
                </span>
              </button>
              <button
                data-testid="open-template-store"
                onClick={() => setTemplateStoreOpen(true)}
              >
                <Sparkles size={18} />
                <span>
                  <strong>{t("automation.create.template")}</strong>
                  <small>{t("automation.create.templateHint")}</small>
                </span>
              </button>
            </div>

            {loading ? (
              <div className={automationClass("home-empty")}>
                <Activity className={automationClass("spin")} size={22} />
                <strong>{t("automation.loading.title")}</strong>
                <span>{t("automation.loading.description")}</span>
              </div>
            ) : null}

            {!loading &&
              visibleRules.map((rule) => (
                <AutomationCard
                  key={rule.id}
                  rule={rule}
                  onOpen={() => openRule(rule)}
                  onRun={onRunRule ? () => runRule(rule) : undefined}
                  running={runningIds.has(rule.id)}
                  canManage={canManage}
                  onToggle={async () => {
                    try {
                      const updated = onToggleRule
                        ? await onToggleRule(rule, !rule.enabled)
                        : { ...rule, enabled: !rule.enabled };
                      setRules((current) =>
                        current.map((item) =>
                          item.id === rule.id ? updated : item,
                        ),
                      );
                    } catch (toggleError) {
                      notify(
                        toggleError instanceof Error
                          ? toggleError.message
                          : String(toggleError),
                      );
                    }
                  }}
                  onDuplicate={() => duplicateRule(rule)}
                  onDelete={() => deleteRule(rule)}
                />
              ))}
          </section>

          {error ? (
            <div className={automationClass("home-empty")}>
              <XCircle size={22} />
              <strong>{t("automation.loadFailed")}</strong>
              <span>{error}</span>
              {onReload ? (
                <button onClick={() => void onReload()}>
                  {t("automation.reload")}
                </button>
              ) : null}
            </div>
          ) : null}

          {!loading && !error && !visibleRules.length ? (
            <div className={automationClass("home-empty")}>
              <Search size={22} />
              <strong>{t("automation.empty.title")}</strong>
              <span>{t("automation.empty.description")}</span>
            </div>
          ) : null}
        </section>
      ) : (
        <section className={automationClass("project-runs-section")}>
          <button
            className={automationClass("back-to-automation")}
            onClick={() => setHomeTab("rules")}
          >
            <ArrowLeft size={14} />
            {t("automation.backToRules")}
          </button>
          <RunsHome
            runs={runs}
            rules={rules}
            loading={runsLoading}
            onOpenRule={openRule}
          />
        </section>
      )}
    </main>
  );

  return (
    <div
      className={automationClass("automation-root")}
      data-testid="project-automation-view"
    >
      {content}
      {toast ? (
        <div className={automationClass("toast")}>
          <CheckCircle2 size={16} />
          {toast}
        </div>
      ) : null}

      {templateStoreOpen ? (
        <TemplateStore
          templates={automationTemplates(t)}
          onClose={() => setTemplateStoreOpen(false)}
          onApply={applyTemplate}
        />
      ) : null}
    </div>
  );
}

function TemplateStore({ templates, onClose, onApply }) {
  const { t } = useTranslation("common");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selectedId, setSelectedId] = useState(templates[0]?.id);
  const normalizedQuery = query.trim().toLowerCase();

  const visibleTemplates = useMemo(
    () =>
      templates.filter((template) => {
        const matchesCategory =
          category === "all" ||
          (category === "featured"
            ? template.featured
            : template.category === category);
        const matchesQuery =
          !normalizedQuery ||
          `${template.name} ${template.description} ${template.tags.join(" ")}`
            .toLowerCase()
            .includes(normalizedQuery);
        return matchesCategory && matchesQuery;
      }),
    [category, normalizedQuery, templates],
  );

  const selectedTemplate =
    visibleTemplates.find((template) => template.id === selectedId) ??
    visibleTemplates[0] ??
    null;

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className={automationClass("template-store-overlay")}
      data-testid="template-store"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={automationClass("template-store-dialog")}
        role="dialog"
        aria-modal="true"
      >
        <header className={automationClass("template-store-header")}>
          <div>
            <span className={automationClass("template-store-mark")}>
              <Sparkles size={18} />
            </span>
            <div>
              <h2>{t("automation.templateStore.title")}</h2>
              <p>{t("automation.templateStore.description")}</p>
            </div>
          </div>
          <label className={automationClass("template-search")}>
            <Search size={15} />
            <input
              data-testid="template-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("automation.templateStore.search")}
              autoFocus
            />
            {query ? (
              <button
                type="button"
                data-testid="clear-template-search"
                onClick={() => setQuery("")}
                aria-label={t("automation.templateStore.clearSearch")}
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          <button
            className={automationClass("template-store-close")}
            type="button"
            data-testid="close-template-store"
            onClick={onClose}
            aria-label={t("automation.templateStore.close")}
          >
            <X size={17} />
          </button>
        </header>

        <div className={automationClass("template-store-body")}>
          <nav
            className={automationClass("template-categories")}
            aria-label={t("automation.templateStore.category")}
          >
            {[
              ["all", t("automation.templateStore.all"), LayoutGrid],
              ["featured", t("automation.templateStore.featured"), Sparkles],
              ["issue", t("automation.templateStore.issue"), Webhook],
              ["schedule", t("automation.templateStore.schedule"), Clock3],
            ].map(([value, label, Icon]) => (
              <button
                key={value}
                className={category === value ? "active" : ""}
                type="button"
                data-testid={`template-category-${value}`}
                onClick={() => setCategory(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>

          <main className={automationClass("template-library")}>
            <div className={automationClass("template-library-title")}>
              <div>
                <h3>
                  {category === "all"
                    ? t("automation.templateStore.all")
                    : category === "featured"
                      ? t("automation.templateStore.featuredTitle")
                      : category === "issue"
                        ? t("automation.templateStore.issue")
                        : t("automation.templateStore.schedule")}
                </h3>
                <span>
                  {t("automation.templateStore.count", {
                    count: visibleTemplates.length,
                  })}
                </span>
              </div>
              <small>{t("automation.templateStore.builtin")}</small>
            </div>

            {visibleTemplates.length ? (
              <div className={automationClass("template-grid")}>
                {visibleTemplates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    selected={selectedTemplate?.id === template.id}
                    onSelect={() => setSelectedId(template.id)}
                    onApply={() => onApply(template)}
                  />
                ))}
              </div>
            ) : (
              <div className={automationClass("template-empty")}>
                <Search size={22} />
                <strong>{t("automation.templateStore.emptyTitle")}</strong>
                <span>{t("automation.templateStore.emptyDescription")}</span>
              </div>
            )}
          </main>

          <aside className={automationClass("template-preview")}>
            {selectedTemplate ? (
              <>
                <div className={automationClass("template-preview-head")}>
                  <TemplateIcon type={selectedTemplate.icon} />
                  <div>
                    <small>{t("automation.templateStore.preview")}</small>
                    <h3>{selectedTemplate.name}</h3>
                  </div>
                </div>
                <p>{selectedTemplate.description}</p>
                <div className={automationClass("template-preview-trigger")}>
                  <span>
                    {selectedTemplate.trigger.type === "schedule" ? (
                      <Clock3 size={15} />
                    ) : (
                      <Webhook size={15} />
                    )}
                  </span>
                  <div>
                    <small>{t("automation.templateStore.trigger")}</small>
                    <strong>
                      {triggerPresentation(selectedTemplate.trigger, t).label}
                    </strong>
                  </div>
                </div>
                <div className={automationClass("template-preview-steps")}>
                  <small>
                    {t("automation.templateStore.workflow", {
                      count: selectedTemplate.steps.length,
                    })}
                  </small>
                  {selectedTemplate.steps.map((step, index) => (
                    <div key={`${selectedTemplate.id}-${step.name}`}>
                      <span>{index + 1}</span>
                      <strong>{step.name}</strong>
                    </div>
                  ))}
                </div>
                <div className={automationClass("template-preview-footer")}>
                  <p>{t("automation.templateStore.detachedHint")}</p>
                  <button
                    type="button"
                    data-testid="apply-selected-template"
                    onClick={() => onApply(selectedTemplate)}
                  >
                    {t("automation.templateStore.use")}
                  </button>
                </div>
              </>
            ) : (
              <div className={automationClass("template-preview-empty")}>
                {t("automation.templateStore.select")}
              </div>
            )}
          </aside>
        </div>
      </section>
    </div>
  );
}

function TemplateCard({ template, selected, onSelect, onApply }) {
  const { t } = useTranslation("common");
  const trigger = triggerPresentation(template.trigger, t);
  return (
    <article
      className={automationClass(`template-card ${selected ? "selected" : ""}`)}
    >
      <button
        className={automationClass("template-card-main")}
        type="button"
        data-testid={`template-card-${template.id}`}
        onClick={onSelect}
      >
        <TemplateIcon type={template.icon} />
        <span className={automationClass("template-card-copy")}>
          <span>
            <strong>{template.name}</strong>
            {template.featured ? (
              <small>{t("automation.templateStore.recommended")}</small>
            ) : null}
          </span>
          <p>{template.description}</p>
          <span className={automationClass("template-card-meta")}>
            <span>{trigger.label}</span>
            <span>
              {t("automation.templateStore.nodes", {
                count: template.steps.length,
              })}
            </span>
          </span>
        </span>
      </button>
      <button
        className={automationClass("template-card-apply")}
        type="button"
        data-testid={`apply-template-${template.id}`}
        onClick={onApply}
      >
        {t("automation.templateStore.apply")}
      </button>
    </article>
  );
}

function TemplateIcon({ type }) {
  const Icon =
    type === "schedule"
      ? Clock3
      : type === "testing"
        ? CheckCircle2
        : type === "defect"
          ? GitBranch
          : Code2;
  return (
    <span className={automationClass(`template-icon ${type}`)}>
      <Icon size={18} />
    </span>
  );
}

function AutomationCard({
  rule,
  canManage,
  onOpen,
  onToggle,
  onDuplicate,
  onDelete,
  onRun,
  running,
}) {
  const { t } = useTranslation("common");
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = triggerPresentation(rule.trigger, t);
  const TriggerIcon = rule.trigger.type === "schedule" ? Clock3 : Webhook;
  const statusText = running
    ? t("workbench.board_automation_running")
    : rule.enabled
      ? rule.nextRunAt
        ? t("automation.rule.nextRun", { time: formatCardTime(rule.nextRunAt) })
        : t("automation.rule.running")
      : t("automation.rule.disabled");
  const lastRunText = rule.lastRunAt
    ? `${formatCardTimestamp(rule.lastRunAt)}${rule.lastRunStatus ? ` · ${runStatusPresentation(rule.lastRunStatus, t).label}` : ""}`
    : t("automation.rule.neverRun");

  return (
    <article
      className={automationClass(
        `automation-card ${rule.enabled ? "enabled" : ""}`,
      )}
      data-testid={`automation-card-${rule.id}`}
      onClick={(event) => {
        if (event.target.closest("button")) return;
        onOpen();
      }}
    >
      <div className={automationClass("card-head")}>
        <span className={automationClass("automation-icon")}>
          <Zap size={19} />
        </span>
        <div className={automationClass("card-title")}>
          <h3>{rule.name}</h3>
          <span className={automationClass("card-status")}>
            <i />
            {statusText}
          </span>
        </div>
        <div className={automationClass("card-menu-anchor")}>
          <PopupMenu
            testId={`automation-menu-${rule.id}`}
            menuWidth={144}
            triggerClassName={automationClass("icon-button")}
            ariaLabel={t("automation.rule.moreActions")}
            trigger={<MoreHorizontal size={17} />}
          >
            {(close) => (
              <>
                <button
                  className={automationClass("card-menu-action")}
                  onClick={() => {
                    close();
                    onDuplicate();
                  }}
                >
                  <Copy size={14} />
                  {t("automation.rule.duplicate")}
                </button>
                <button
                  className={automationClass("card-menu-action danger")}
                  onClick={() => {
                    close();
                    onDelete();
                  }}
                >
                  <Trash2 size={14} />
                  {t("automation.rule.delete")}
                </button>
              </>
            )}
          </PopupMenu>
        </div>
      </div>

      <div className={automationClass("trigger-summary")}>
        <TriggerIcon
          className={automationClass("trigger-summary-icon")}
          size={18}
        />
        <div className={automationClass("trigger-summary-copy")}>
          <span>{t("automation.rule.trigger")}</span>
          <strong>{trigger.label}</strong>
          <small>{trigger.detail}</small>
        </div>
      </div>

      <div className={automationClass("card-footer")}>
        <div className={automationClass("card-last-run")}>
          <span>{t("automation.rule.lastRun")}</span>
          <strong>{lastRunText}</strong>
        </div>
        <div className={automationClass("card-actions")}>
          {rule.trigger.type === "schedule" && onRun ? (
            <button
              className={automationClass("card-run-action")}
              data-testid={`automation-run-${rule.id}`}
              disabled={!canManage || running}
              onClick={(event) => {
                event.stopPropagation();
                onRun();
              }}
            >
              <Play size={14} />
              {t(
                running
                  ? "workbench.board_automation_running"
                  : "workbench.board_automation_run",
              )}
            </button>
          ) : null}
          <button
            role="switch"
            aria-checked={rule.enabled}
            aria-label={t(
              rule.enabled
                ? "automation.rule.disable"
                : "automation.rule.enable",
            )}
            data-testid={`automation-toggle-${rule.id}`}
            disabled={!canManage}
            className={automationClass(`switch ${rule.enabled ? "on" : ""}`)}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            <span>
              <i />
            </span>
          </button>
        </div>
      </div>
    </article>
  );
}

function formatCardTimestamp(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function formatCardTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
}

function WorkflowEditor({
  draft,
  runs,
  runsLoading,
  dirty,
  saveState,
  saveError,
  editorSection,
  selectedNode,
  panelTab,
  canManage,
  canRun,
  running,
  onRun,
  projectTags,
  eventSourceCatalog,
  projectIncomingHookApi,
  projectId,
  executionCatalog,
  onBack,
  onSelectNode,
  onPanelTabChange,
  onDraftChange,
  onRetrySave,
  onAddStep,
  onRemoveStep,
  onOpenPluginMenu,
  onEditorSectionChange,
  onTriggerCollectionModeChange,
}) {
  const { t } = useTranslation("common");
  const [runStatus, setRunStatus] = useState("all");
  const [selectedRunId, setSelectedRunId] = useState(runs[0]?.id ?? null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(draft.name);
  const renameInputRef = useRef(null);
  const deleteButtonRef = useRef(null);
  const needsSave = dirty || !draft.persisted;
  const trigger = triggerPresentation(draft.trigger, t);
  const TriggerIcon = draft.trigger.type === "schedule" ? Clock3 : Webhook;
  const visibleRuns = runs.filter((run) =>
    runMatchesFilter(run.status, runStatus),
  );
  const selectedRun =
    visibleRuns.find((run) => run.id === selectedRunId) ??
    visibleRuns[0] ??
    null;
  const latestRun = runs[0] ?? null;
  const selectedStep =
    selectedNode.type === "step"
      ? (draft.steps.find((step) => step.id === selectedNode.id) ?? null)
      : null;
  const selectedDagParent =
    selectedNode.type === "dagStage"
      ? (draft.steps.find((step) => step.id === selectedNode.stepId) ?? null)
      : null;
  const selectedDagStage =
    selectedDagParent?.subgraph?.nodes.find(
      (stage) => stage.id === selectedNode.stageId,
    ) ?? null;
  const selectedLoopParent =
    selectedNode.type === "loopBody"
      ? (draft.steps.find((step) => step.id === selectedNode.loopId) ?? null)
      : null;
  const selectedLoopBody =
    selectedLoopParent?.subgraph?.nodes.find(
      (bodyStep) => bodyStep.id === selectedNode.bodyId,
    ) ?? null;
  const eventTypeOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (eventSourceCatalog ?? []).flatMap(
            (source) => source.eventTypes ?? [],
          ),
        ),
      ).sort(),
    [eventSourceCatalog],
  );
  const branchConditionCatalog = useMemo(() => {
    const sources = (eventSourceCatalog ?? []).filter(
      (source) =>
        source.sourceType === "github" || source.sourceType === "gitlab",
    );
    if (sources.length > 0) {
      return sources.map((source) => ({
        sourceType: source.sourceType,
        eventTypes:
          source.eventTypes?.filter((eventType) =>
            eventType.startsWith("change_request."),
          ) ?? [],
      }));
    }
    return [{ sourceType: "github", eventTypes: eventTypeOptions }];
  }, [eventSourceCatalog, eventTypeOptions]);
  const hasSelectedNode = selectedNode.type !== "none";
  const showRightPanel = editorSection === "runs" || hasSelectedNode;

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
      return;
    }
    setRenameValue(draft.name);
  }, [draft.name, renaming]);

  useEffect(() => {
    const deleteSelectedNode = (event) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.closest(
            'input, textarea, select, [contenteditable="true"], [role="textbox"]',
          ))
      ) {
        return;
      }

      const deleteButton = deleteButtonRef.current;
      if (!deleteButton) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      deleteButton.click();
    };

    window.addEventListener("keydown", deleteSelectedNode, true);
    return () =>
      window.removeEventListener("keydown", deleteSelectedNode, true);
  }, []);

  const updateTrigger = (key, value) => {
    onDraftChange((current) => ({
      ...current,
      trigger: { ...current.trigger, [key]: value },
    }));
  };

  const updateRule = (key, value) => {
    onDraftChange((current) => ({ ...current, [key]: value }));
  };

  const startRenaming = () => {
    setRenameValue(draft.name);
    setRenaming(true);
  };

  const commitRename = () => {
    const value = renameValue.trim();
    setRenameValue(value || draft.name);
    setRenaming(false);
    if (value && value !== draft.name) updateRule("name", value);
  };

  const cancelRename = () => {
    setRenameValue(draft.name);
    setRenaming(false);
  };

  const updateStep = (key, value) => {
    if (!selectedStep) return;
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === selectedStep.id ? { ...step, [key]: value } : step,
      ),
    }));
  };

  const updateDagStage = (key, value) => {
    if (!selectedDagParent || !selectedDagStage) return;
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === selectedDagParent.id
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map((stage) =>
                  stage.id === selectedDagStage.id
                    ? { ...stage, [key]: value }
                    : stage,
                ),
              },
            }
          : step,
      ),
    }));
  };

  const addDagStage = (stepId, anchorStageId = null, placement = "after") => {
    const id = `dag-stage-${Date.now()}`;
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.id !== stepId) return step;
        if (step.subgraph.nodes.length === 0) {
          return {
            ...step,
            subgraph: {
              nodes: [
                createStageConstraint({
                  id,
                  name: t("automation.node.newStage"),
                  prompt: t("automation.node.newStagePrompt"),
                  dependencies: [],
                  dependencyContext: {},
                  x: 24,
                  y: 105,
                }),
              ],
            },
          };
        }
        const anchorIndex = step.subgraph.nodes.findIndex(
          (stage) => stage.id === anchorStageId,
        );
        const anchor = step.subgraph.nodes[anchorIndex];
        if (!anchor) return step;
        const insertionX = placement === "before" ? anchor.x : anchor.x + 200;
        const shifted = step.subgraph.nodes.map((stage) =>
          stage.id !== anchor.id && stage.x >= insertionX
            ? { ...stage, x: stage.x + 200 }
            : stage,
        );
        const dependencies =
          placement === "before" ? [...anchor.dependencies] : [anchorStageId];
        const stage = createStageConstraint({
          id,
          name: t("automation.node.newStage"),
          prompt: t("automation.node.newStagePrompt"),
          dependencies,
          dependencyContext:
            placement === "before"
              ? { ...(anchor.dependencyContext ?? {}) }
              : {
                  [anchorStageId]: ["final_result", "deliveries"],
                },
          x: insertionX,
          y: anchor.y,
        });
        const rewired = shifted.map((candidate) => {
          if (placement === "before" && candidate.id === anchor.id) {
            return {
              ...candidate,
              x: candidate.x + 200,
              dependencies: [stage.id],
              dependencyContext: {
                [stage.id]: ["final_result", "deliveries"],
              },
            };
          }
          if (
            placement !== "after" ||
            !candidate.dependencies.includes(anchor.id)
          ) {
            return candidate;
          }
          return {
            ...candidate,
            dependencies: candidate.dependencies.map((dependencyId) =>
              dependencyId === anchor.id ? stage.id : dependencyId,
            ),
            dependencyContext: {
              ...Object.fromEntries(
                Object.entries(candidate.dependencyContext ?? {}).filter(
                  ([dependencyId]) => dependencyId !== anchor.id,
                ),
              ),
              [stage.id]: candidate.dependencyContext?.[anchor.id] ?? [
                "final_result",
                "deliveries",
              ],
            },
          };
        });
        const nodes = [...rewired];
        nodes.splice(
          placement === "before" ? anchorIndex : anchorIndex + 1,
          0,
          stage,
        );
        return {
          ...step,
          subgraph: {
            nodes,
          },
        };
      }),
    }));
    onSelectNode({ type: "dagStage", stepId, stageId: id });
  };

  const removeDagStage = (
    stepId = selectedDagParent?.id,
    stageId = selectedDagStage?.id,
  ) => {
    if (!stepId || !stageId) return;
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes
                  .filter((stage) => stage.id !== stageId)
                  .map((stage) => ({
                    ...stage,
                    dependencies: stage.dependencies.filter(
                      (id) => id !== stageId,
                    ),
                    dependencyContext: Object.fromEntries(
                      Object.entries(stage.dependencyContext).filter(
                        ([dependencyId]) => dependencyId !== stageId,
                      ),
                    ),
                  })),
              },
            }
          : step,
      ),
    }));
    onSelectNode({ type: "step", id: stepId });
  };

  const toggleDagDependency = (stepId, stageId, dependencyId) => {
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map((stage) =>
                  stage.id === stageId
                    ? {
                        ...stage,
                        dependencies: stage.dependencies.includes(dependencyId)
                          ? stage.dependencies.filter(
                              (id) => id !== dependencyId,
                            )
                          : [...stage.dependencies, dependencyId],
                        dependencyContext: stage.dependencies.includes(
                          dependencyId,
                        )
                          ? Object.fromEntries(
                              Object.entries(stage.dependencyContext).filter(
                                ([id]) => id !== dependencyId,
                              ),
                            )
                          : {
                              ...stage.dependencyContext,
                              [dependencyId]: ["final_result", "deliveries"],
                            },
                      }
                    : stage,
                ),
              },
            }
          : step,
      ),
    }));
  };

  const moveDagStage = (stepId, stageId, x, y) => {
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              subgraph: {
                nodes: step.subgraph.nodes.map((stage) =>
                  stage.id === stageId ? { ...stage, x, y } : stage,
                ),
              },
            }
          : step,
      ),
    }));
  };

  const insertLoopBodyNode = (
    loopId,
    anchorBodyId = null,
    placement = "after",
    kind = "task",
  ) => {
    const bodyStep = createLoopBodyNode(executionCatalog, loopId, kind, t);
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.id !== loopId) return step;
        const body = [...(step.subgraph?.nodes ?? [])];
        const anchorIndex = anchorBodyId
          ? body.findIndex((candidate) => candidate.id === anchorBodyId)
          : -1;
        const anchor = anchorIndex >= 0 ? body[anchorIndex] : null;
        const loopStart = body.find(
          (candidate) => candidate.nodeType === "loopStart",
        );
        const insertionX = anchor ? anchor.x + 260 : 0;
        const insertionY = anchor?.y ?? body.length * 120;
        const inserted = {
          ...bodyStep,
          x: insertionX,
          y: insertionY,
          dependencies:
            kind === "branch" && loopStart
              ? [loopStart.id]
              : anchorBodyId
                ? [anchorBodyId]
                : [],
        };
        const next = [...body];
        next.splice(
          anchorIndex >= 0
            ? anchorIndex + (placement === "after" ? 1 : 0)
            : next.length,
          0,
          inserted,
        );
        return {
          ...step,
          bodyNodeIds: [...(step.bodyNodeIds ?? []), inserted.id],
          subgraph: { nodes: next },
        };
      }),
    }));
    onSelectNode({ type: "loopBody", loopId, bodyId: bodyStep.id });
  };

  const toggleLoopBodyDependency = (loopId, targetBodyId, sourceBodyId) => {
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.id !== loopId) return step;
        return {
          ...step,
          subgraph: {
            nodes: (step.subgraph?.nodes ?? []).map((bodyStep) =>
              bodyStep.id === targetBodyId
                ? {
                    ...bodyStep,
                    dependencies: bodyStep.dependencies.includes(sourceBodyId)
                      ? bodyStep.dependencies.filter(
                          (id) => id !== sourceBodyId,
                        )
                      : [...bodyStep.dependencies, sourceBodyId],
                    dependencyContext: bodyStep.dependencies.includes(
                      sourceBodyId,
                    )
                      ? Object.fromEntries(
                          Object.entries(
                            bodyStep.dependencyContext ?? {},
                          ).filter(([id]) => id !== sourceBodyId),
                        )
                      : {
                          ...(bodyStep.dependencyContext ?? {}),
                          [sourceBodyId]: ["final_result", "deliveries"],
                        },
                  }
                : bodyStep,
            ),
          },
        };
      }),
    }));
  };

  const moveLoopBodyNode = (loopId, bodyId, x, y) => {
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === loopId
          ? {
              ...step,
              subgraph: {
                nodes: (step.subgraph?.nodes ?? []).map((bodyStep) =>
                  bodyStep.id === bodyId ? { ...bodyStep, x, y } : bodyStep,
                ),
              },
            }
          : step,
      ),
    }));
  };

  const updateLoopBodyStep = (key, value) => {
    if (selectedNode.type !== "loopBody") return;
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === selectedNode.loopId
          ? {
              ...step,
              subgraph: {
                nodes: (step.subgraph?.nodes ?? []).map((bodyStep) =>
                  bodyStep.id === selectedNode.bodyId
                    ? { ...bodyStep, [key]: value }
                    : bodyStep,
                ),
              },
            }
          : step,
      ),
    }));
  };

  const removeLoopBodyStep = (
    loopId = selectedNode.loopId,
    bodyId = selectedNode.bodyId,
  ) => {
    if (!loopId || !bodyId) return;
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) => {
        if (step.id !== loopId) return step;
        return {
          ...step,
          bodyNodeIds: (step.bodyNodeIds ?? []).filter((id) => id !== bodyId),
          subgraph: {
            nodes: (step.subgraph?.nodes ?? [])
              .filter((bodyStep) => bodyStep.id !== bodyId)
              .map((bodyStep) => ({
                ...bodyStep,
                dependencies: bodyStep.dependencies.filter(
                  (id) => id !== bodyId,
                ),
                dependencyContext: Object.fromEntries(
                  Object.entries(bodyStep.dependencyContext ?? {}).filter(
                    ([id]) => id !== bodyId,
                  ),
                ),
                branchConditions: (bodyStep.branchConditions ?? []).map(
                  (condition) => ({
                    ...condition,
                    handlerNodeIds: condition.handlerNodeIds.filter(
                      (id) => id !== bodyId,
                    ),
                  }),
                ),
              })),
          },
        };
      }),
    }));
    onSelectNode({ type: "none" });
  };

  const deleteCanvasNode = (node) => {
    if (node.type === "dagStage") {
      const [, stepId, stageId] = node.id.split(":");
      removeDagStage(stepId, stageId);
      return;
    }
    if (
      node.type === "loopBody" ||
      node.type === "loopBranch" ||
      node.type === "loopMarker"
    ) {
      const [, loopId, bodyId] = node.id.split(":");
      removeLoopBodyStep(loopId, bodyId);
      return;
    }
    onRemoveStep(node.id);
  };

  const toggleStepDependency = (targetId, dependencyId) => {
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === targetId
          ? {
              ...step,
              dependencies: step.dependencies.includes(dependencyId)
                ? step.dependencies.filter((id) => id !== dependencyId)
                : [...step.dependencies, dependencyId],
              dependencyContext: step.dependencies.includes(dependencyId)
                ? Object.fromEntries(
                    Object.entries(step.dependencyContext).filter(
                      ([id]) => id !== dependencyId,
                    ),
                  )
                : {
                    ...step.dependencyContext,
                    [dependencyId]: ["final_result", "deliveries"],
                  },
            }
          : step,
      ),
    }));
  };

  const moveStep = (stepId, x, y) => {
    onDraftChange((current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.id === stepId ? { ...step, x, y } : step,
      ),
    }));
  };

  const addBranchHandler = (branchId, { kind = "task", select = "branch" }) => {
    const branchOwner = findBranchOwner(draft.steps, branchId);
    if (!branchOwner) return;
    const currentConditions = branchOwner.step.branchConditions ?? [];
    const usedKeys = new Set(
      currentConditions.map(
        (condition) =>
          `${condition.sourceType ?? "github"}:${condition.eventType ?? ""}`,
      ),
    );
    const defaultCondition = branchConditionCatalog.flatMap((source) =>
      source.eventTypes
        .filter(
          (eventType) => !usedKeys.has(`${source.sourceType}:${eventType}`),
        )
        .map((eventType) => ({ sourceType: source.sourceType, eventType })),
    )[0] ?? { sourceType: "github", eventType: "" };

    let handlerNode;
    let handlerId;
    if (branchOwner.type === "top") {
      handlerId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      handlerNode = createBranchHandlerNode(
        executionCatalog,
        kind,
        handlerId,
        t,
      );
    } else {
      handlerNode = createLoopBranchHandlerNode(
        executionCatalog,
        branchOwner.step.id,
        kind,
        t,
      );
      handlerId = handlerNode.id;
    }

    if (branchOwner.type === "top") {
      onDraftChange((current) => {
        const result = insertStepAfter(current.steps, branchId, handlerNode, {
          gap: BRANCH_HANDLER_COLUMN_GAP,
          condition: defaultCondition,
          stack: true,
        });
        if (!result) return current;
        return { ...current, steps: result.container };
      });
    } else {
      onDraftChange((current) => ({
        ...current,
        steps: current.steps.map((step) => {
          if (step.id !== branchOwner.step.id) return step;
          const result = insertStepAfter(
            step.subgraph?.nodes ?? [],
            branchId,
            handlerNode,
            {
              gap: LOOP_BODY_HANDLER_COLUMN_GAP,
              condition: defaultCondition,
              stack: true,
              nodeSize: loopBodyNodeSize,
            },
          );
          if (!result) return step;
          return {
            ...step,
            bodyNodeIds: [...(step.bodyNodeIds ?? []), result.nodeId],
            subgraph: { nodes: result.container },
          };
        }),
      }));
    }

    if (select === "handler") {
      if (branchOwner.type === "top")
        onSelectNode({ type: "step", id: handlerId });
      else
        onSelectNode({
          type: "loopBody",
          loopId: branchOwner.step.id,
          bodyId: handlerId,
        });
    } else {
      if (branchOwner.type === "top")
        onSelectNode({ type: "step", id: branchId });
      else
        onSelectNode({
          type: "loopBody",
          loopId: branchOwner.step.id,
          bodyId: branchId,
        });
    }
  };

  const addBranchContinuation = (branchId, kind = "task") => {
    const branchOwner = findBranchOwner(draft.steps, branchId);
    if (!branchOwner || branchOwner.type !== "top") return;

    const nodeId = `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const continuationNode = createBranchHandlerNode(
      executionCatalog,
      kind,
      nodeId,
      t,
    );
    onDraftChange((current) => {
      const result = insertStepAfter(
        current.steps,
        branchId,
        continuationNode,
        {
          gap: BRANCH_HANDLER_COLUMN_GAP,
        },
      );
      if (!result) return current;
      return { ...current, steps: result.container };
    });
    onSelectNode({ type: "step", id: nodeId });
  };

  const insertNode = (anchorStepId, placement, kind) => {
    onAddStep(anchorStepId, placement, kind);
  };

  const workspaceActions = (
    <div
      className={automationClass("editor-global-actions")}
      data-testid="automation-editor-global-actions"
    >
      {saveState === "error" ? (
        <button
          type="button"
          className={automationClass("editor-save-state error")}
          data-testid="automation-save-retry"
          title={saveError}
          onClick={onRetrySave}
        >
          <i />
          {t("automation.editor.saveFailed")}
        </button>
      ) : (
        <span
          className={automationClass(`editor-save-state ${saveState}`)}
          title={saveError}
        >
          <i />
          {saveState === "saving"
            ? t("automation.editor.saving")
            : saveState === "invalid"
              ? t("automation.editor.incomplete")
              : saveState === "pending" || needsSave
                ? t("automation.editor.pending")
                : t("automation.editor.saved")}
        </span>
      )}
      {draft.trigger.type === "schedule" ? (
        <button
          className={automationClass("dark-secondary")}
          data-testid="automation-run"
          disabled={!canRun || needsSave || saveState !== "saved" || running}
          title={
            needsSave ? t("workbench.board_automation_save_first") : undefined
          }
          onClick={onRun}
        >
          <Play size={16} />
          {t(
            running
              ? "workbench.board_automation_running"
              : "workbench.board_automation_run",
          )}
        </button>
      ) : null}
    </div>
  );

  return (
    <div
      className={automationClass("editor-shell")}
      data-testid="automation-rule-editor"
      style={{
        "--automation-panel-gap": `${AUTOMATION_PANEL_GAP}px`,
        "--automation-right-panel-width": showRightPanel
          ? `${AUTOMATION_RIGHT_PANEL_WIDTH}px`
          : "0px",
        "--automation-right-panel-top": `${AUTOMATION_RIGHT_PANEL_TOP}px`,
      }}
    >
      <div className={automationClass("editor-body")}>
        <div
          className={automationClass("editor-navigation-actions")}
          data-testid="automation-editor-navigation"
        >
          <div
            className={automationClass("editor-object-bar")}
            data-testid="automation-editor-object-bar"
          >
            <button
              className={automationClass("editor-back-button")}
              data-testid="automation-editor-back"
              onClick={onBack}
              aria-label={t("automation.editor.back")}
            >
              <ArrowLeft size={16} />
            </button>
            <span className={automationClass("editor-object-divider")} />
            {renaming ? (
              <input
                ref={renameInputRef}
                className={automationClass("editor-name-input")}
                data-testid="automation-editor-name-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelRename();
                  }
                }}
                aria-label={t("automation.editor.name")}
                spellCheck={false}
              />
            ) : (
              <button
                type="button"
                className={automationClass("editor-name-button")}
                data-testid="automation-editor-name"
                title={draft.name}
                aria-label={t("automation.editor.rename", { name: draft.name })}
                onClick={startRenaming}
              >
                <span>{draft.name}</span>
                <Pencil size={16} />
              </button>
            )}
          </div>

          <div
            className={automationClass("editor-view-tabs")}
            data-testid="automation-editor-section-menu"
            role="tablist"
            aria-label={t("automation.editor.views")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={editorSection === "workflow"}
              className={automationClass(
                "editor-view-tab",
                editorSection === "workflow" && "active",
              )}
              data-testid="editor-nav-workflow"
              onClick={() => onEditorSectionChange("workflow")}
            >
              <GitBranch size={16} />
              <span>{t("automation.editor.workflow")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={editorSection === "runs"}
              className={automationClass(
                "editor-view-tab",
                editorSection === "runs" && "active",
              )}
              data-testid="open-current-automation-runs"
              onClick={() => onEditorSectionChange("runs")}
            >
              <History size={16} />
              <span>{t("automation.runs.title")}</span>
            </button>
          </div>
        </div>

        {editorSection === "workflow" ? (
          <main className={automationClass("workflow-canvas")}>
            <AutomationWorkflowCanvas
              draft={draft}
              trigger={trigger}
              selectedNode={selectedNode}
              rightPanelInset={
                showRightPanel
                  ? AUTOMATION_RIGHT_PANEL_WIDTH + AUTOMATION_PANEL_GAP
                  : 0
              }
              onSelectNode={onSelectNode}
              onInsertNode={insertNode}
              onAddBranchHandler={addBranchHandler}
              onAddBranchContinuation={addBranchContinuation}
              onAddDagStage={addDagStage}
              onToggleDagDependency={toggleDagDependency}
              onMoveDagStage={moveDagStage}
              onToggleStepDependency={toggleStepDependency}
              onMoveStep={moveStep}
              onInsertLoopBodyNode={insertLoopBodyNode}
              onToggleLoopBodyDependency={toggleLoopBodyDependency}
              onMoveLoopBodyNode={moveLoopBodyNode}
              onDeleteNode={deleteCanvasNode}
            />
          </main>
        ) : (
          <RuleRunsPanel
            runs={visibleRuns}
            loading={runsLoading}
            status={runStatus}
            selectedRun={selectedRun}
            onStatusChange={setRunStatus}
            onSelectRun={(run) => setSelectedRunId(run.id)}
          />
        )}

        {workspaceActions}

        {editorSection === "workflow" ? (
          hasSelectedNode ? (
            <aside
              className={automationClass("editor-rightbar")}
              data-testid="automation-editor-rightbar"
            >
              <div className={automationClass("node-panel")}>
                <div className={automationClass("panel-head")}>
                  <span
                    className={automationClass(
                      `node-icon ${
                        selectedStep?.kind === "branch" ||
                        selectedLoopBody?.nodeType === "branch"
                          ? "branch"
                          : selectedStep?.kind === "dynamic" ||
                              selectedStep?.kind === "loop"
                            ? "coordinator"
                            : selectedNode.type
                      }`,
                    )}
                  >
                    {selectedNode.type === "trigger" ? (
                      <TriggerIcon size={17} />
                    ) : selectedStep?.kind === "dynamic" ? (
                      <Sparkles size={17} />
                    ) : selectedStep?.kind === "loop" ? (
                      <Repeat size={17} />
                    ) : selectedStep?.kind === "branch" ? (
                      <Webhook size={17} />
                    ) : selectedLoopBody?.nodeType === "branch" ? (
                      <Webhook size={17} />
                    ) : selectedLoopBody?.nodeType === "loopStart" ? (
                      <CircleDot size={17} />
                    ) : selectedLoopBody?.nodeType === "loopEnd" ? (
                      <Flag size={17} />
                    ) : (
                      <Box size={17} />
                    )}
                  </span>
                  <div className={automationClass("panel-head-copy")}>
                    <strong>
                      {selectedNode.type === "trigger"
                        ? t("automation.rule.trigger")
                        : selectedDagStage
                          ? selectedDagStage.name
                          : selectedStep?.kind === "dynamic"
                            ? t("automation.node.dynamic")
                            : selectedStep?.kind === "loop"
                              ? selectedStep?.name ||
                                t("automation.node.unnamedLoop")
                              : selectedStep?.kind === "branch"
                                ? selectedStep?.name ||
                                  t("automation.node.branch")
                                : selectedLoopBody?.nodeType === "branch"
                                  ? selectedLoopBody.name ||
                                    t("automation.node.branch")
                                  : selectedLoopBody?.nodeType === "loopStart"
                                    ? selectedLoopBody.name ||
                                      t("automation.node.loopStart")
                                    : selectedLoopBody?.nodeType === "loopEnd"
                                      ? selectedLoopBody.name ||
                                        t("automation.node.loopEnd")
                                      : selectedLoopBody
                                        ? selectedLoopBody.name ||
                                          t("automation.node.loopBody")
                                        : selectedStep?.name ||
                                          t("automation.node.unnamed")}
                    </strong>
                    <small>
                      {selectedNode.type === "trigger"
                        ? t("automation.editor.triggerEntry")
                        : selectedDagStage
                          ? t("automation.editor.dagNode")
                          : selectedStep?.kind === "dynamic"
                            ? t("automation.editor.dynamicHint")
                            : selectedStep?.kind === "loop"
                              ? t("automation.editor.loopHint")
                              : selectedStep?.kind === "branch"
                                ? t("automation.editor.branchHint")
                                : selectedLoopBody?.nodeType === "branch"
                                  ? t("automation.editor.branchHint")
                                  : selectedLoopBody?.nodeType === "loopStart"
                                    ? t("automation.editor.loopStartHint")
                                    : selectedLoopBody?.nodeType === "loopEnd"
                                      ? t("automation.editor.loopEndHint")
                                      : selectedLoopBody
                                        ? t("automation.editor.loopBodyHint")
                                        : t(
                                            "automation.editor.executionSettings",
                                          )}
                    </small>
                  </div>
                  <button
                    type="button"
                    className={automationClass("panel-close")}
                    data-testid="automation-editor-close-rightbar"
                    aria-label={t("automation.editor.closeNode")}
                    onClick={() => onSelectNode({ type: "none" })}
                  >
                    <X size={17} />
                  </button>
                </div>

                <div className={automationClass("panel-tabs")}>
                  <button
                    type="button"
                    className={panelTab === "settings" ? "active" : ""}
                    data-testid="automation-panel-tab-settings"
                    onClick={() => onPanelTabChange("settings")}
                  >
                    {t("automation.editor.settings")}
                  </button>
                  <button
                    type="button"
                    className={panelTab === "lastRun" ? "active" : ""}
                    data-testid="automation-panel-tab-last-run"
                    onClick={() => onPanelTabChange("lastRun")}
                  >
                    {t("automation.editor.lastRun")}
                  </button>
                </div>

                {panelTab === "lastRun" ? (
                  <div className={automationClass("last-run-panel")}>
                    {runsLoading ? (
                      <>
                        <Activity
                          className={automationClass("spin")}
                          size={24}
                        />
                        <strong>{t("automation.editor.loadingRuns")}</strong>
                      </>
                    ) : latestRun ? (
                      <>
                        <RunStatusIcon status={latestRun.status} size={24} />
                        <strong>
                          {t("automation.editor.latestRun", {
                            status: runStatusPresentation(latestRun.status, t)
                              .label,
                          })}
                        </strong>
                        <span>
                          {latestRun.startedAt} · {latestRun.duration}
                        </span>
                        <button onClick={() => onEditorSectionChange("runs")}>
                          {t("automation.editor.openRuns")}
                        </button>
                      </>
                    ) : (
                      <>
                        <History size={24} />
                        <strong>{t("automation.editor.noRuns")}</strong>
                        <span>{t("automation.editor.noRunsHint")}</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className={automationClass("panel-content")}>
                    {selectedNode.type === "trigger" ? (
                      <TriggerSettings
                        draft={draft}
                        projectTags={projectTags}
                        eventSourceCatalog={eventSourceCatalog}
                        projectIncomingHookApi={projectIncomingHookApi}
                        projectId={projectId}
                        canManage={canManage}
                        onChange={updateTrigger}
                        onRuleChange={updateRule}
                        onCollectionModeChange={onTriggerCollectionModeChange}
                      />
                    ) : selectedDagStage ? (
                      <>
                        <StepSettings
                          step={selectedDagStage}
                          executionCatalog={executionCatalog}
                          onChange={updateDagStage}
                          onDelete={() => removeDagStage()}
                          deleteButtonRef={deleteButtonRef}
                          onOpenPluginMenu={onOpenPluginMenu}
                          constraint
                          supplemental={
                            <SubgraphDependencySummary
                              node={selectedDagStage}
                              parent={selectedDagParent}
                              onChange={updateDagStage}
                            />
                          }
                        />
                      </>
                    ) : selectedStep?.kind === "dynamic" ? (
                      <CoordinatorSettings
                        coordinator={selectedStep}
                        executionCatalog={executionCatalog}
                        onChange={updateStep}
                        onDelete={() => onRemoveStep()}
                        deleteButtonRef={deleteButtonRef}
                        onOpenPluginMenu={onOpenPluginMenu}
                      />
                    ) : selectedStep?.kind === "loop" ? (
                      <LoopSettings
                        step={selectedStep}
                        onChange={updateStep}
                        onDelete={() => onRemoveStep()}
                      />
                    ) : selectedStep?.kind === "branch" ? (
                      <BranchSettings
                        step={selectedStep}
                        bodyNodes={draft.steps}
                        eventTypeOptions={eventTypeOptions}
                        eventSourceCatalog={eventSourceCatalog}
                        projectIncomingHookApi={projectIncomingHookApi}
                        projectId={projectId}
                        canManage={canManage}
                        onChange={updateStep}
                        onDelete={() => onRemoveStep()}
                      />
                    ) : selectedLoopBody?.nodeType === "branch" ? (
                      <BranchSettings
                        step={selectedLoopBody}
                        bodyNodes={selectedLoopParent?.subgraph?.nodes ?? []}
                        eventTypeOptions={eventTypeOptions}
                        eventSourceCatalog={eventSourceCatalog}
                        projectIncomingHookApi={projectIncomingHookApi}
                        projectId={projectId}
                        canManage={canManage}
                        onChange={updateLoopBodyStep}
                        onDelete={() => removeLoopBodyStep()}
                      />
                    ) : selectedLoopBody?.nodeType === "loopStart" ? (
                      <div className={automationClass("panel-settings")}>
                        <p className={automationClass("execution-hint")}>
                          {t("automation.node.loopStartDescription")}
                        </p>
                      </div>
                    ) : selectedLoopBody?.nodeType === "loopEnd" ? (
                      <div className={automationClass("panel-settings")}>
                        <label className={automationClass("panel-field")}>
                          <span>
                            <Flag size={14} />
                            {t("automation.node.name")}
                          </span>
                          <input
                            data-testid="loop-end-node-name"
                            value={selectedLoopBody.name}
                            onChange={(event) =>
                              updateLoopBodyStep("name", event.target.value)
                            }
                          />
                        </label>
                        <p className={automationClass("execution-hint")}>
                          {t("automation.node.loopEndDescription")}
                        </p>
                        <div
                          className={automationClass(
                            "panel-danger-zone compact",
                          )}
                        >
                          <button
                            type="button"
                            className={automationClass("delete-step")}
                            data-testid="loop-end-node-delete"
                            onClick={removeLoopBodyStep}
                          >
                            <Trash2 size={14} />
                            {t("automation.node.deleteLoopEnd")}
                          </button>
                        </div>
                      </div>
                    ) : selectedLoopBody ? (
                      <StepSettings
                        step={selectedLoopBody}
                        executionCatalog={executionCatalog}
                        onChange={updateLoopBodyStep}
                        onDelete={() => removeLoopBodyStep()}
                        onOpenPluginMenu={onOpenPluginMenu}
                      />
                    ) : (
                      <StepSettings
                        step={selectedStep}
                        executionCatalog={executionCatalog}
                        onChange={updateStep}
                        onDelete={() => onRemoveStep()}
                        deleteButtonRef={deleteButtonRef}
                        onOpenPluginMenu={onOpenPluginMenu}
                      />
                    )}
                  </div>
                )}
              </div>
            </aside>
          ) : null
        ) : (
          <aside
            className={automationClass("editor-rightbar")}
            data-testid="automation-editor-rightbar"
          >
            <RunDetailPanel run={selectedRun} steps={draft.steps} />
          </aside>
        )}
      </div>
    </div>
  );
}

function RuleRunsPanel({
  runs,
  loading,
  status,
  selectedRun,
  onStatusChange,
  onSelectRun,
}) {
  const { t } = useTranslation("common");
  return (
    <main
      className={automationClass("rule-runs-view")}
      data-testid="current-automation-runs"
    >
      <div className={automationClass("rule-runs-header")}>
        <div>
          <h2>{t("automation.runs.title")}</h2>
          <p>{t("automation.runs.currentDescription")}</p>
        </div>
        <div className={automationClass("rule-run-filters")}>
          {[
            ["all", t("automation.filter.all")],
            ["active", t("automation.runs.active")],
            ["success", t("automation.status.succeeded")],
            ["failed", t("automation.status.failed")],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? "active" : ""}
              data-testid={`current-run-filter-${value}`}
              onClick={() => onStatusChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div
          className={automationClass("rule-runs-empty")}
          data-testid="automation-runs-loading"
        >
          <Activity className={automationClass("spin")} size={22} />
          <strong>{t("automation.editor.loadingRuns")}</strong>
        </div>
      ) : runs.length ? (
        <div className={automationClass("rule-runs-list")}>
          <div className={automationClass("rule-runs-list-head")}>
            <span>{t("automation.runs.issue")}</span>
            <span>{t("automation.runs.status")}</span>
            <span>{t("automation.runs.startedAt")}</span>
            <span>{t("automation.runs.duration")}</span>
          </div>
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={automationClass(
                `rule-run-row ${selectedRun?.id === run.id ? "selected" : ""}`,
              )}
              data-testid={`current-run-${run.id}`}
              onClick={() => onSelectRun(run)}
            >
              <span>
                <strong>{run.issue}</strong>
                <small>{t("automation.runs.triggeredByCurrent")}</small>
              </span>
              <RunStatus status={run.status} />
              <span>{run.startedAt}</span>
              <span>{run.duration}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className={automationClass("rule-runs-empty")}>
          <History size={24} />
          <strong>{t("automation.runs.currentEmpty")}</strong>
          <span>{t("automation.runs.currentEmptyHint")}</span>
        </div>
      )}
    </main>
  );
}

function RunDetailPanel({ run, steps }) {
  const { t } = useTranslation("common");
  if (!run) {
    return (
      <aside className={automationClass("run-detail-panel empty")}>
        <History size={24} />
        <strong>{t("automation.runs.noDetails")}</strong>
        <span>{t("automation.runs.noDetailsHint")}</span>
      </aside>
    );
  }

  const presentation = runStatusPresentation(run.status, t);

  return (
    <aside className={automationClass("run-detail-panel")}>
      <div className={automationClass("run-detail-head")}>
        <span
          className={automationClass(`run-detail-icon ${presentation.tone}`)}
        >
          <RunStatusIcon status={run.status} size={18} />
        </span>
        <div>
          <strong>{t("automation.runs.details")}</strong>
          <small>{run.startedAt}</small>
        </div>
      </div>

      <div className={automationClass("run-detail-summary")}>
        <div>
          <span>{t("automation.runs.status")}</span>
          <RunStatus status={run.status} />
        </div>
        <div>
          <span>{t("automation.runs.target")}</span>
          <strong>{run.issue}</strong>
        </div>
        <div>
          <span>{t("automation.runs.totalDuration")}</span>
          <strong>{run.duration}</strong>
        </div>
      </div>

      <div className={automationClass("run-detail-steps")}>
        <span>{t("automation.runs.workflow")}</span>
        {steps.map((step, index) => (
          <div key={step.id}>
            <span className={automationClass("run-step-state pending")}>
              {index + 1}
            </span>
            <div>
              <strong>
                {step.name || t("automation.runs.step", { index: index + 1 })}
              </strong>
              <small>{t("automation.runs.pendingResult")}</small>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function RunStatusIcon({ status, size }) {
  const { t } = useTranslation("common");
  const Icon = runStatusPresentation(status, t).icon;
  return <Icon size={size} />;
}

function RunStatus({ status }) {
  const { t } = useTranslation("common");
  const presentation = runStatusPresentation(status, t);
  return (
    <span className={automationClass(`run-status ${presentation.tone}`)}>
      <RunStatusIcon status={status} size={14} />
      {presentation.label}
    </span>
  );
}

function PollIntervalField({ testId, value, onChange, index }) {
  const { t } = useTranslation("common");
  const minutes = Math.max(1, Math.round((value ?? 300) / 60));
  const suggestionsId = `${testId}-suggestions`;
  return (
    <label className={automationClass("panel-field")}>
      <span>
        {index ? (
          <i className={automationClass("cascade-index")}>{index}</i>
        ) : null}
        {t("automation.poll.interval")}
      </span>
      <div className={automationClass("poll-interval-control")}>
        <input
          data-testid={testId}
          type="number"
          min={1}
          max={1440}
          step={1}
          list={suggestionsId}
          value={minutes}
          onChange={(event) =>
            onChange(Math.max(1, Number(event.target.value) || 1) * 60)
          }
        />
        <span>{t("automation.poll.minutes")}</span>
        <datalist id={suggestionsId}>
          <option value="1" />
          <option value="3" />
          <option value="5" />
          <option value="10" />
          <option value="30" />
        </datalist>
      </div>
      <small className={automationClass("panel-field-hint")}>
        {t("automation.poll.hint")}
      </small>
    </label>
  );
}

function TriggerSettings({
  draft,
  projectTags,
  eventSourceCatalog,
  projectIncomingHookApi,
  projectId,
  canManage,
  onChange,
  onRuleChange,
  onCollectionModeChange,
}) {
  const { t } = useTranslation("common");
  const trigger = draft.trigger;
  const presentation = triggerPresentation(trigger, t);
  const TriggerIcon = trigger.type === "schedule" ? Clock3 : Webhook;
  const startMode = trigger.startMode ?? "immediate";
  const isSchedule = trigger.type === "schedule";
  const isWework = trigger.source === "wework";
  const isGeneric = trigger.source === "generic";
  const collectionMode = trigger.collectionMode ?? "webhook";
  const triggerKind = isSchedule
    ? "schedule"
    : isWework
      ? "wework"
      : isGeneric
        ? "generic"
        : collectionMode;
  const selectedSource = eventSourceCatalog.find(
    (source) => source.sourceType === trigger.source,
  );
  const platformSources = (mode) =>
    eventSourceCatalog.filter(
      (item) =>
        item.sourceType !== "wework" &&
        item.sourceType !== "generic" &&
        (item.collectionModes ?? []).includes(mode),
    );
  const candidatePlatforms = platformSources(triggerKind);
  const hasPlatformStep =
    (triggerKind === "webhook" || triggerKind === "poll") &&
    candidatePlatforms.length > 0;
  const selectedPlatforms = hasPlatformStep ? candidatePlatforms : [];
  const sourceLabel = (sourceType) => {
    const labels = {
      schedule: t("todo.automation_trigger_schedule_label"),
      wework: t("todo.automation_trigger_wework_label"),
      webhook: t("todo.automation_trigger_webhook_label"),
      poll: t("todo.automation_trigger_poll_label"),
      github: t("todo.automation_trigger_github_label"),
      gitlab: t("todo.automation_trigger_gitlab_label"),
      generic: t("todo.automation_trigger_generic_label"),
    };
    return labels[sourceType] ?? sourceType;
  };
  const toggleTag = (tag) => {
    onChange(
      "tags",
      trigger.tags.includes(tag)
        ? trigger.tags.filter((item) => item !== tag)
        : [...trigger.tags, tag],
    );
  };

  const updateSchedule = (key, value) => {
    onChange("schedule", { ...trigger.schedule, [key]: value });
  };

  const handleSubscriptionChange = (subscriptionId) => {
    onChange("subscriptionId", subscriptionId);
    onChange(
      "event",
      selectedSource?.eventTypes[0] ?? "change_request.checks_failed",
    );
  };

  const handlePollIntervalChange = (value) => {
    onChange("pollIntervalSeconds", value);
    const subscriptionId = trigger.subscriptionId;
    if (!subscriptionId || !projectIncomingHookApi || !projectId) return;
    const subscription = pollingSubscriptionRef.current;
    if (!subscription || subscription.id !== subscriptionId) return;
    void projectIncomingHookApi
      .update(projectId, subscriptionId, {
        version: subscription.version,
        pollIntervalSeconds: value,
      })
      .then((updated) => {
        pollingSubscriptionRef.current = updated;
      })
      .catch(() => undefined);
  };

  const applyPlatform = (sourceType) => {
    const source = eventSourceCatalog.find(
      (item) => item.sourceType === sourceType,
    );
    onChange("source", sourceType);
    onChange("subscriptionId", null);
    onChange("event", source?.eventTypes[0] ?? "change_request.checks_failed");
  };

  const handleTriggerKindChange = (value) => {
    if (value === "schedule") {
      onChange("type", "schedule");
      return;
    }
    onChange("type", "event");
    if (value === "wework") {
      onChange("source", "wework");
      onChange("collectionMode", null);
      onChange("subscriptionId", null);
      onChange(
        "event",
        trigger.startMode === "status" ? "status_changed" : "created",
      );
      return;
    }
    // Webhook and polling are collection mechanisms; keep the current platform
    // when it supports the new mechanism and fall back to the first one otherwise.
    const platforms = platformSources(value);
    const nextSource =
      selectedSource &&
      platforms.some((item) => item.sourceType === selectedSource.sourceType)
        ? selectedSource.sourceType
        : (platforms[0]?.sourceType ?? "github");
    onChange("collectionMode", value);
    applyPlatform(nextSource);
    onCollectionModeChange?.();
  };

  return (
    <div className={automationClass("panel-settings")}>
      <label className={automationClass("panel-field")}>
        <span>{t("automation.settings.description")}</span>
        <textarea
          data-testid="automation-rule-description"
          value={draft.description}
          placeholder={t("automation.settings.descriptionPlaceholder")}
          onChange={(event) => onRuleChange("description", event.target.value)}
        />
      </label>
      <div className={automationClass("prominent-trigger")}>
        <TriggerIcon size={18} />
        <div>
          <strong>{t("automation.settings.whenTitle")}</strong>
          <span>{t("automation.settings.whenHint")}</span>
        </div>
      </div>
      <label className={automationClass("panel-field")}>
        <span>
          <i className={automationClass("cascade-index")}>1</i>
          {t("automation.settings.eventSource")}
        </span>
        <select
          data-testid="automation-trigger-type"
          value={triggerKind}
          onChange={(event) => handleTriggerKindChange(event.target.value)}
        >
          <option value="schedule">
            {t("todo.automation_trigger_schedule_label")}
          </option>
          <option value="wework">
            {t("todo.automation_trigger_wework_label")}
          </option>
          <option value="webhook">
            {t("todo.automation_trigger_webhook_label")}
          </option>
          <option value="poll">
            {t("todo.automation_trigger_poll_label")}
          </option>
          {isGeneric ? (
            <option value="generic" disabled>
              {t("todo.automation_trigger_generic_label")}
            </option>
          ) : null}
        </select>
      </label>
      {trigger.type === "schedule" ? (
        <section className={automationClass("schedule-settings")}>
          <label className={automationClass("panel-field")}>
            <span>
              <i className={automationClass("cascade-index")}>2</i>
              {t("automation.settings.frequency")}
            </span>
            <select
              data-testid="automation-trigger-frequency"
              value={trigger.schedule.frequency}
              onChange={(event) =>
                updateSchedule("frequency", event.target.value)
              }
            >
              <option value="hourly">
                {t("workbench.board_automation_hourly")}
              </option>
              <option value="daily">{t("automation.trigger.daily")}</option>
              <option value="weekdays">
                {t("automation.trigger.weekdays")}
              </option>
              <option value="weekly">{t("automation.trigger.weekly")}</option>
            </select>
          </label>
          {trigger.schedule.frequency === "weekly" ? (
            <label className={automationClass("panel-field")}>
              <span>
                <i className={automationClass("cascade-index")}>3</i>
                {t("automation.settings.weekday")}
              </span>
              <select
                data-testid="automation-trigger-weekday"
                value={trigger.schedule.weekday}
                onChange={(event) =>
                  updateSchedule("weekday", event.target.value)
                }
              >
                {[
                  "monday",
                  "tuesday",
                  "wednesday",
                  "thursday",
                  "friday",
                  "saturday",
                  "sunday",
                ].map((value) => (
                  <option key={value} value={value}>
                    {t(`automation.trigger.${value}`)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className={automationClass("panel-field")}>
            <span>
              <i className={automationClass("cascade-index")}>
                {trigger.schedule.frequency === "weekly" ? "4" : "3"}
              </i>
              {trigger.schedule.frequency === "hourly"
                ? t("workbench.board_automation_minute")
                : t("automation.settings.runTime")}
            </span>
            {trigger.schedule.frequency === "hourly" ? (
              <select
                data-testid="automation-trigger-minute"
                value={Number(trigger.schedule.time.split(":")[1])}
                onChange={(event) =>
                  updateSchedule(
                    "time",
                    `00:${event.target.value.padStart(2, "0")}`,
                  )
                }
              >
                {Array.from({ length: 60 }, (_, minute) => (
                  <option key={minute} value={minute}>
                    {String(minute).padStart(2, "0")}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="time"
                data-testid="automation-trigger-time"
                value={trigger.schedule.time}
                onChange={(event) => updateSchedule("time", event.target.value)}
              />
            )}
          </label>
          <label className={automationClass("panel-field")}>
            <span>
              <i className={automationClass("cascade-index")}>
                {trigger.schedule.frequency === "weekly" ? "5" : "4"}
              </i>
              {t("automation.settings.timezone")}
            </span>
            <select
              data-testid="automation-trigger-timezone"
              value={trigger.schedule.timezone}
              onChange={(event) =>
                updateSchedule("timezone", event.target.value)
              }
            >
              <option value="Asia/Shanghai">
                {t("automation.settings.shanghaiTime")}
              </option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="UTC">UTC</option>
            </select>
          </label>
        </section>
      ) : trigger.source !== "wework" ? (
        <section className={automationClass("event-source-settings")}>
          <div className={automationClass("event-source-heading")}>
            <div>
              <strong>{t("automation.settings.externalSource")}</strong>
              <span>{t("automation.settings.externalSourceHint")}</span>
            </div>
            <small>{sourceLabel(collectionMode)}</small>
          </div>
          {selectedPlatforms.length ? (
            <label className={automationClass("panel-field")}>
              <span>
                <i className={automationClass("cascade-index")}>2</i>
                {t("todo.automation_trigger_platform")}
              </span>
              <select
                data-testid="automation-trigger-platform"
                value={trigger.source}
                onChange={(event) => applyPlatform(event.target.value)}
              >
                {selectedPlatforms.map((item) => (
                  <option key={item.sourceType} value={item.sourceType}>
                    {sourceLabel(item.sourceType)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {collectionMode === "poll" ? (
            <PollIntervalField
              testId="automation-trigger-poll-interval"
              value={trigger.pollIntervalSeconds}
              index={hasPlatformStep ? 3 : 2}
              onChange={handlePollIntervalChange}
            />
          ) : null}
          {collectionMode === "webhook" ? (
            <EventSubscriptionPicker
              key={`${collectionMode}:${trigger.source}`}
              api={projectIncomingHookApi}
              projectId={projectId}
              catalog={eventSourceCatalog}
              sourceTypes={[trigger.source]}
              collectionMode="webhook"
              cascadeIndex={hasPlatformStep ? 3 : 2}
              canManage={canManage}
              value={trigger.subscriptionId}
              onChange={handleSubscriptionChange}
            />
          ) : null}
          <label className={automationClass("panel-field")}>
            <span>
              <i className={automationClass("cascade-index")}>
                {hasPlatformStep ? 4 : 3}
              </i>
              {t("todo.automation_target_branches")}
            </span>
            <input
              data-testid="automation-target-branches"
              value={(trigger.targetBranches ?? []).join(", ")}
              onChange={(event) =>
                onChange(
                  "targetBranches",
                  event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                )
              }
              placeholder="main, release"
            />
          </label>
          <label className={automationClass("panel-field")}>
            <span>
              <i className={automationClass("cascade-index")}>
                {hasPlatformStep ? 5 : 4}
              </i>
              {t("todo.automation_event_type")}
            </span>
            <select
              data-testid="automation-external-event-type"
              value={trigger.event}
              onChange={(event) => onChange("event", event.target.value)}
            >
              {(selectedSource?.eventTypes ?? []).map((eventType) => (
                <option key={eventType} value={eventType}>
                  {eventTypeLabel(eventType, t)}
                </option>
              ))}
            </select>
          </label>
          {trigger.event === "change_request.comment_created" ? (
            <p
              className={automationClass("execution-hint")}
              data-testid="automation-event-comment-loop-hint"
            >
              {t("todo.automation_event_comment_loop_hint")}
            </p>
          ) : null}
          <p className={automationClass("execution-hint")}>
            {t("automation.settings.externalExecutionHint")}
          </p>
        </section>
      ) : (
        <>
          <section className={automationClass("start-mode-section")}>
            <div className={automationClass("cascade-heading")}>
              <i className={automationClass("cascade-index")}>2</i>
              <div>
                <strong>{t("automation.settings.startMode")}</strong>
                <span>{t("automation.settings.startModeHint")}</span>
              </div>
            </div>
            <div className={automationClass("start-mode-options")}>
              <button
                type="button"
                data-testid="automation-start-mode-immediate"
                className={startMode === "immediate" ? "selected" : ""}
                aria-pressed={startMode === "immediate"}
                onClick={() => onChange("startMode", "immediate")}
              >
                <span className={automationClass("start-mode-radio")}>
                  {startMode === "immediate" ? <Check size={12} /> : null}
                </span>
                <span>
                  <strong>{t("automation.settings.startImmediate")}</strong>
                  <small>{t("automation.settings.startImmediateHint")}</small>
                </span>
              </button>
              <button
                type="button"
                data-testid="automation-start-mode-status"
                className={startMode === "status" ? "selected" : ""}
                aria-pressed={startMode === "status"}
                onClick={() => onChange("startMode", "status")}
              >
                <span className={automationClass("start-mode-radio")}>
                  {startMode === "status" ? <Check size={12} /> : null}
                </span>
                <span>
                  <strong>{t("automation.settings.startStatus")}</strong>
                  <small>{t("automation.settings.startStatusHint")}</small>
                </span>
              </button>
            </div>
          </section>
          {startMode === "immediate" ? (
            <section className={automationClass("tag-filter")}>
              <div className={automationClass("tag-filter-heading")}>
                <div>
                  <strong>{t("automation.settings.filterTags")}</strong>
                  <span>{t("automation.settings.optional")}</span>
                </div>
              </div>
              <div className={automationClass("tag-options")}>
                {projectTags.map((tag) => {
                  const selected = trigger.tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      data-testid={`automation-trigger-tag-${tag}`}
                      className={selected ? "selected" : ""}
                      aria-pressed={selected}
                      onClick={() => toggleTag(tag)}
                    >
                      <span>{selected ? <Check size={12} /> : null}</span>
                      {tag}
                    </button>
                  );
                })}
              </div>
              {!projectTags.length ? (
                <p>{t("automation.settings.noTags")}</p>
              ) : null}
              <p>{t("automation.settings.tagsHint")}</p>
            </section>
          ) : (
            <section className={automationClass("execution-status-scope")}>
              <div className={automationClass("cascade-heading")}>
                <i className={automationClass("cascade-index")}>3</i>
                <div>
                  <strong>{t("automation.settings.processingTitle")}</strong>
                  <span>{t("automation.settings.processingHint")}</span>
                </div>
              </div>
              <p>{t("automation.settings.processingDescription")}</p>
            </section>
          )}
        </>
      )}
      <div className={automationClass("trigger-explanation")}>
        <Zap size={15} />
        <div>
          <strong>{presentation.label}</strong>
          <p>{presentation.detail}</p>
        </div>
      </div>
    </div>
  );
}

function PluginSelector({
  testId,
  selectedPlugins,
  options,
  onToggle,
  onOpen,
}) {
  const { t } = useTranslation("common");
  const optionForLabel = (label) =>
    options.find((option) => option.label === label) ?? {
      id: label,
      label,
      reference: { displayName: label },
    };

  return (
    <div className={automationClass("panel-plugins")}>
      {selectedPlugins.map((plugin) => (
        <button
          key={plugin}
          type="button"
          onClick={() => onToggle(optionForLabel(plugin))}
        >
          {plugin}
          <X size={12} />
        </button>
      ))}
      <PopupMenu
        testId={testId}
        keepOpen
        menuWidth={224}
        triggerClassName="add"
        onOpen={onOpen}
        trigger={
          <span className="inline-flex items-center gap-1">
            <Plus size={12} />
            {t("automation.plugin.add")}
          </span>
        }
      >
        {() =>
          options.length ? (
            options.map((option) => {
              const checked = selectedPlugins.includes(option.label);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  data-testid={`${testId}-option-${option.id}`}
                  onClick={() => onToggle(option)}
                  className="flex h-9 w-full items-center gap-2 rounded-lg bg-transparent px-2.5 text-left text-xs text-text-secondary hover:bg-muted"
                >
                  <span
                    className={automationClass(
                      "grid size-4 place-items-center rounded border border-border-strong",
                      checked && "border-focus bg-focus text-white",
                    )}
                  >
                    {checked ? <Check size={11} /> : null}
                  </span>
                  {option.label}
                </button>
              );
            })
          ) : (
            <small className="block px-2.5 py-2 text-xs text-text-muted">
              {t("automation.plugin.empty")}
            </small>
          )
        }
      </PopupMenu>
    </div>
  );
}

function CoordinatorSettings({
  coordinator,
  executionCatalog,
  onChange,
  onDelete,
  deleteButtonRef,
  onOpenPluginMenu,
}) {
  const { t } = useTranslation("common");
  const environmentOptions = executionCatalog.environments.some(
    (option) => option.deviceId === coordinator.executionDeviceId,
  )
    ? executionCatalog.environments
    : coordinator.executionDeviceId
      ? [
          {
            deviceId: coordinator.executionDeviceId,
            label: coordinator.environment,
            executionEnvironment: coordinator.executionEnvironment,
          },
          ...executionCatalog.environments,
        ]
      : executionCatalog.environments;
  const modelOptions = executionCatalog.models.some(
    (option) => option.name === coordinator.model,
  )
    ? executionCatalog.models
    : coordinator.model
      ? [
          {
            name: coordinator.model,
            label: coordinator.model,
            type: coordinator.modelType,
            options: coordinator.modelOptions,
          },
          ...executionCatalog.models,
        ]
      : executionCatalog.models;
  const configuredPluginOptions = [
    ...executionCatalog.plugins,
    ...coordinator.plugins
      .filter(
        (label) =>
          !executionCatalog.plugins.some((option) => option.label === label),
      )
      .map((label) => ({
        id: label,
        label,
        reference: { displayName: label },
      })),
  ];
  const runtimeProfiles = executionCatalog.runtimeProfiles ?? [];

  const selectRuntimeProfile = (profileId) => {
    const profile = runtimeProfiles.find((item) => item.id === profileId);
    if (!profile) {
      onChange("runtimeProfileId", null);
      return;
    }
    onChange("runtimeProfileId", profile.id);
    onChange("executionDeviceId", profile.executionDeviceId);
    onChange("executionEnvironment", profile.executionEnvironment);
    onChange("environment", profile.name);
    onChange("model", profile.model);
    onChange("modelType", profile.modelType);
    onChange("modelOptions", profile.modelOptions);
  };

  const selectEnvironment = (deviceId) => {
    if (!deviceId) {
      clearExecutionEnvironment(onChange);
      return;
    }
    const option = environmentOptions.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (!option) return;
    onChange("executionDeviceId", option.deviceId);
    onChange("executionEnvironment", option.executionEnvironment);
    onChange("environment", option.label);
    onChange("runtimeProfileId", null);
  };

  const selectModel = (name) => {
    if (!name) {
      clearExecutionModel(onChange);
      return;
    }
    const option = modelOptions.find((candidate) => candidate.name === name);
    if (!option) return;
    onChange("model", option.name);
    onChange("modelType", option.type);
    onChange("modelOptions", option.options);
    onChange("runtimeProfileId", null);
  };

  const togglePlugin = (option) => {
    const selected = coordinator.plugins.includes(option.label);
    onChange(
      "plugins",
      selected
        ? coordinator.plugins.filter((item) => item !== option.label)
        : [...coordinator.plugins, option.label],
    );
    onChange(
      "projectPlugins",
      selected
        ? coordinator.projectPlugins.filter((item) => item.id !== option.id)
        : [...coordinator.projectPlugins, option.reference],
    );
  };

  return (
    <div className={automationClass("panel-settings")}>
      <div className={automationClass("coordinator-intro")}>
        <Sparkles size={17} />
        <div>
          <strong>{t("automation.coordinator.title")}</strong>
          <span>{t("automation.coordinator.description")}</span>
        </div>
      </div>

      <div
        className={automationClass(
          "node-model-settings coordinator-model-settings",
        )}
      >
        {runtimeProfiles.length ? (
          <label className={automationClass("panel-field")}>
            <span>
              <Settings2 size={14} />
              {t("automation.execution.runtimeProfile")}
            </span>
            <select
              data-testid="ai-coordinator-runtime-profile"
              value={coordinator.runtimeProfileId ?? ""}
              onChange={(event) => selectRuntimeProfile(event.target.value)}
            >
              <option value="">
                {t("automation.execution.customConfiguration")}
              </option>
              {runtimeProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={automationClass("panel-field")}>
          <span>
            <Laptop size={14} />
            {t("automation.coordinator.environment")}
          </span>
          <ExecutionEnvironmentSelect
            testId="ai-coordinator-environment"
            value={coordinator.executionDeviceId ?? ""}
            options={environmentOptions}
            onChange={selectEnvironment}
          />
        </label>
        <label className={automationClass("panel-field")}>
          <span>
            <Sparkles size={14} />
            {t("automation.coordinator.model")}
          </span>
          <select
            data-testid="ai-coordinator-model"
            value={coordinator.model}
            onChange={(event) => selectModel(event.target.value)}
          >
            <option value="">{t("automation.step.noModel")}</option>
            {modelOptions.map((option) => (
              <option key={`${option.type}-${option.name}`} value={option.name}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className={automationClass("panel-field")}>
          <span>
            <Puzzle size={14} />
            {t("automation.coordinator.plugins")}
          </span>
          <PluginSelector
            testId="ai-coordinator-add-plugin"
            selectedPlugins={coordinator.plugins}
            options={configuredPluginOptions}
            onToggle={togglePlugin}
            onOpen={onOpenPluginMenu}
          />
        </div>
      </div>

      <label className={automationClass("panel-field")}>
        <span>
          <Code2 size={14} />
          {t("automation.coordinator.prompt")}
        </span>
        <textarea
          data-testid="ai-coordinator-prompt"
          value={coordinator.prompt}
          placeholder={t("automation.coordinator.promptPlaceholder")}
          onChange={(event) => onChange("prompt", event.target.value)}
        />
      </label>
      <fieldset className={automationClass("execution-mode")}>
        <legend>{t("automation.coordinator.approval")}</legend>
        <div>
          <button
            type="button"
            data-testid="ai-coordinator-approval-required"
            className={
              coordinator.approvalPolicy !== "automatic" ? "selected" : ""
            }
            onClick={() => onChange("approvalPolicy", "required")}
          >
            <UserRound size={16} />
            {t("automation.coordinator.approvalManual")}
          </button>
          <button
            type="button"
            data-testid="ai-coordinator-approval-automatic"
            className={
              coordinator.approvalPolicy === "automatic" ? "selected" : ""
            }
            onClick={() => onChange("approvalPolicy", "automatic")}
          >
            <Bot size={16} />
            {t("automation.coordinator.approvalAutomatic")}
          </button>
        </div>
      </fieldset>
      <p className={automationClass("execution-hint")}>
        {t("automation.coordinator.approvalHint")}
      </p>
      <div className={automationClass("panel-danger-zone compact")}>
        <button
          ref={deleteButtonRef}
          type="button"
          className={automationClass("delete-step")}
          data-testid="ai-coordinator-delete"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          {t("automation.coordinator.delete")}
        </button>
      </div>
    </div>
  );
}

function LoopSettings({ step, onChange, onDelete }) {
  const { t } = useTranslation("common");
  const loopConfig = normalizeLoopConfig(step.loopConfig);
  const updateLoopConfig = (next) => onChange("loopConfig", next);
  return (
    <div className={automationClass("panel-settings")}>
      <label className={automationClass("panel-field")}>
        <span>
          <Repeat size={14} />
          {t("automation.loop.name")}
        </span>
        <input
          data-testid="loop-node-name"
          value={step.name}
          placeholder={t("automation.loop.namePlaceholder")}
          onChange={(event) => onChange("name", event.target.value)}
        />
      </label>

      <div className={automationClass("node-model-settings")}>
        <label className={automationClass("panel-field")}>
          <span>
            <Repeat size={14} />
            {t("automation.loop.maxAttempts")}
          </span>
          <input
            data-testid="loop-max-attempts"
            type="number"
            min={0}
            value={loopConfig.maxAttempts}
            onChange={(event) =>
              updateLoopConfig({
                ...loopConfig,
                maxAttempts: Math.max(0, Number(event.target.value) || 0),
              })
            }
          />
        </label>
        <label className={automationClass("panel-field")}>
          <span>
            <Clock3 size={14} />
            {t("automation.loop.timeout")}
          </span>
          <input
            data-testid="loop-timeout-seconds"
            type="number"
            min={1}
            value={loopConfig.timeoutSeconds ?? ""}
            placeholder={t("automation.loop.disabled")}
            onChange={(event) =>
              updateLoopConfig({
                ...loopConfig,
                timeoutSeconds:
                  event.target.value === ""
                    ? null
                    : Math.max(1, Number(event.target.value) || 1),
              })
            }
          />
        </label>
      </div>
      <p className={automationClass("execution-hint")}>
        {t("automation.loop.description")}
      </p>
      <div className={automationClass("panel-danger-zone compact")}>
        <button
          type="button"
          className={automationClass("delete-step")}
          data-testid="loop-node-delete"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          {t("automation.loop.delete")}
        </button>
      </div>
    </div>
  );
}

const branchHandlerPresentation = {
  task: { Icon: Box },
  dynamic: { Icon: Sparkles },
  loop: { Icon: Repeat },
  branch: { Icon: Webhook },
};

function normalizeLoopConfig(config) {
  return {
    maxAttempts: Number.isFinite(config?.maxAttempts) ? config.maxAttempts : 5,
    timeoutSeconds: config?.timeoutSeconds ?? null,
  };
}

function BranchSettings({
  step,
  bodyNodes,
  eventTypeOptions,
  eventSourceCatalog = [],
  projectIncomingHookApi,
  projectId,
  canManage,
  onChange,
  onDelete,
}) {
  const { t } = useTranslation("common");
  const conditions = step.branchConditions ?? [];
  const eventWait = step.eventWait ?? {
    collectionMode: "poll",
    subscriptionId: null,
    pollIntervalSeconds: 300,
  };
  const platformSources = eventSourceCatalog.filter(
    (source) =>
      source.sourceType === "github" || source.sourceType === "gitlab",
  );
  const eventTypesBySource = new Map(
    platformSources.map((source) => [
      source.sourceType,
      (source.eventTypes?.length ? source.eventTypes : eventTypeOptions).filter(
        (eventType) => eventType.startsWith("change_request."),
      ),
    ]),
  );
  const updateCondition = (index, key, value) => {
    onChange(
      "branchConditions",
      conditions.map((condition, candidate) =>
        candidate === index ? { ...condition, [key]: value } : condition,
      ),
    );
  };
  const removeHandler = (index, handlerId) => {
    const condition = conditions[index];
    updateCondition(
      index,
      "handlerNodeIds",
      condition.handlerNodeIds.filter((id) => id !== handlerId),
    );
  };
  const changeCollectionMode = (mode) => {
    onChange("eventWait", {
      ...eventWait,
      collectionMode: mode,
      subscriptionId:
        mode === "webhook" ? (eventWait.subscriptionId ?? null) : null,
      pollIntervalSeconds:
        mode === "poll" ? (eventWait.pollIntervalSeconds ?? 300) : null,
    });
  };
  const changeConditionSource = (index, sourceType) => {
    const supportedEvents = eventTypesBySource.get(sourceType) ?? [];
    const current = conditions[index];
    const nextEventType = supportedEvents.includes(current.eventType)
      ? current.eventType
      : (supportedEvents[0] ?? "");
    onChange(
      "branchConditions",
      conditions.map((condition, candidate) =>
        candidate === index
          ? { ...condition, sourceType, eventType: nextEventType }
          : condition,
      ),
    );
  };
  return (
    <div className={automationClass("panel-settings")}>
      <label className={automationClass("panel-field")}>
        <span>
          <Webhook size={14} />
          {t("automation.branch.name")}
        </span>
        <input
          data-testid="branch-node-name"
          value={step.name}
          onChange={(event) => onChange("name", event.target.value)}
        />
      </label>
      <p className={automationClass("execution-hint")}>
        {t("automation.branch.description")}
      </p>
      <section className={automationClass("event-source-settings")}>
        <div className={automationClass("event-source-heading")}>
          <div>
            <strong>{t("automation.branch.source")}</strong>
            <span>{t("automation.branch.sourceHint")}</span>
          </div>
          <small>
            {[...new Set(conditions.map((condition) => condition.sourceType))]
              .map((sourceType) =>
                sourceType === "gitlab" ? "GitLab" : "GitHub",
              )
              .join(" / ")}
          </small>
        </div>
        {eventWait.collectionMode === "poll" ? (
          <p
            className={automationClass("execution-hint")}
            data-testid="branch-event-sources-hint"
          >
            {t("automation.branch.platformHint")}
          </p>
        ) : null}
        <label className={automationClass("panel-field")}>
          <span>
            <i className={automationClass("cascade-index")}>2</i>
            {t("automation.branch.collectionMode")}
          </span>
          <select
            data-testid="branch-event-wait-mode"
            value={eventWait.collectionMode}
            onChange={(event) => changeCollectionMode(event.target.value)}
          >
            <option value="poll">
              {t("todo.automation_trigger_poll_label")}
            </option>
            <option value="webhook">
              {t("todo.automation_trigger_webhook_label")}
            </option>
          </select>
        </label>
        {eventWait.collectionMode === "webhook" ? (
          <EventSubscriptionPicker
            api={projectIncomingHookApi}
            projectId={projectId}
            catalog={eventSourceCatalog}
            sourceTypes={[
              ...new Set(conditions.map((condition) => condition.sourceType)),
            ]}
            collectionMode="webhook"
            cascadeIndex={3}
            testIdPrefix="branch"
            canManage={canManage}
            value={eventWait.subscriptionId ?? null}
            onChange={(subscriptionId) =>
              onChange("eventWait", { ...eventWait, subscriptionId })
            }
          />
        ) : (
          <PollIntervalField
            testId="branch-event-wait-poll-interval"
            value={eventWait.pollIntervalSeconds}
            index={3}
            onChange={(pollIntervalSeconds) =>
              onChange("eventWait", { ...eventWait, pollIntervalSeconds })
            }
          />
        )}
        {eventWait.collectionMode === "poll" ? (
          <p
            className={automationClass("execution-hint")}
            data-testid="branch-event-wait-poll-hint"
          >
            {t("todo.workflow_branch_collector_poll_hint")}
          </p>
        ) : (
          <p
            className={automationClass("execution-hint")}
            data-testid="branch-event-wait-webhook-hint"
          >
            {t("todo.workflow_branch_collector_webhook_hint")}
          </p>
        )}
      </section>
      <div className={automationClass("branch-conditions")}>
        <span className={automationClass("branch-conditions-heading")}>
          {t("automation.branch.conditions")}
        </span>
        {conditions.length === 0 ? (
          <div className={automationClass("branch-conditions-empty")}>
            {t("automation.branch.empty")}
          </div>
        ) : (
          conditions.map((condition, index) => {
            const handlerNodes = (condition.handlerNodeIds ?? [])
              .map((handlerId) =>
                bodyNodes.find((candidate) => candidate.id === handlerId),
              )
              .filter(Boolean);
            const candidateNodes = bodyNodes.filter(
              (candidate) =>
                candidate.id !== step.id &&
                candidate.kind === "task" &&
                (!candidate.nodeType || candidate.nodeType === "task") &&
                !condition.handlerNodeIds.includes(candidate.id),
            );
            return (
              <div
                className={automationClass("branch-condition-card")}
                key={`condition-${index}`}
              >
                <div className={automationClass("branch-condition-head")}>
                  <em>{t("automation.branch.index", { index: index + 1 })}</em>
                  <button
                    type="button"
                    className={automationClass("branch-condition-remove")}
                    data-testid={`branch-condition-remove-${index}`}
                    aria-label={t("automation.branch.remove", {
                      index: index + 1,
                    })}
                    onClick={() =>
                      onChange(
                        "branchConditions",
                        conditions.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      )
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className={automationClass("branch-condition-source")}>
                  <label className={automationClass("panel-field")}>
                    <span>{t("automation.branch.platform")}</span>
                    <select
                      data-testid={`branch-condition-source-${index}`}
                      value={condition.sourceType}
                      onChange={(event) =>
                        changeConditionSource(index, event.target.value)
                      }
                    >
                      {platformSources.map((source) => (
                        <option
                          key={source.sourceType}
                          value={source.sourceType}
                        >
                          {source.sourceType === "gitlab" ? "GitLab" : "GitHub"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={automationClass("panel-field")}>
                    <span>{t("automation.branch.event")}</span>
                    <select
                      data-testid={`branch-condition-event-${index}`}
                      value={condition.eventType}
                      onChange={(event) =>
                        updateCondition(index, "eventType", event.target.value)
                      }
                    >
                      <option value="">
                        {t("automation.branch.selectEvent")}
                      </option>
                      {(eventTypesBySource.get(condition.sourceType) ?? []).map(
                        (eventType) => (
                          <option key={eventType} value={eventType}>
                            {eventTypeLabel(eventType, t)}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                </div>
                <div className={automationClass("branch-condition-handlers")}>
                  <span>{t("automation.branch.handlers")}</span>
                  <div className={automationClass("branch-handler-chips")}>
                    {handlerNodes.length === 0 ? (
                      <small
                        className={automationClass("branch-handler-empty")}
                      >
                        {t("automation.branch.noHandlers")}
                      </small>
                    ) : (
                      handlerNodes.map((handler) => {
                        const { Icon } =
                          branchHandlerPresentation[handler.kind] ??
                          branchHandlerPresentation.task;
                        return (
                          <span
                            className={automationClass("branch-handler-chip")}
                            key={handler.id}
                          >
                            <Icon size={12} />
                            <em>
                              {handler.name ||
                                t("automation.branch.unnamedNode")}
                            </em>
                            <button
                              type="button"
                              aria-label={t("automation.branch.removeHandler", {
                                name:
                                  handler.name ||
                                  t("automation.branch.unnamedNode"),
                              })}
                              onClick={() => removeHandler(index, handler.id)}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        );
                      })
                    )}
                  </div>
                  {candidateNodes.length > 0 ? (
                    <PopupMenu
                      testId={`branch-add-handler-${index}`}
                      trigger={
                        <span className={automationClass("branch-add-handler")}>
                          <Plus size={13} />
                          {t("automation.branch.assignExisting")}
                        </span>
                      }
                    >
                      {(close) => (
                        <>
                          {candidateNodes.map((candidate) => (
                            <button
                              type="button"
                              key={candidate.id}
                              className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                              data-testid={`branch-add-handler-${index}-${candidate.id}`}
                              onClick={() => {
                                updateCondition(index, "handlerNodeIds", [
                                  ...condition.handlerNodeIds,
                                  candidate.id,
                                ]);
                                close();
                              }}
                            >
                              <Box size={14} />
                              {candidate.name ||
                                t("automation.branch.unnamedNode")}
                            </button>
                          ))}
                        </>
                      )}
                    </PopupMenu>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className={automationClass("panel-danger-zone compact")}>
        <button
          type="button"
          className={automationClass("delete-step")}
          data-testid="branch-node-delete"
          onClick={onDelete}
        >
          <Trash2 size={14} />
          {t("automation.branch.delete")}
        </button>
      </div>
    </div>
  );
}

const DEPENDENCY_CONTEXT_KEYS = {
  final_result: "automation.dependency.finalResult",
  deliveries: "automation.dependency.deliveries",
  activity: "automation.dependency.activity",
};

function SubgraphDependencySummary({ node, parent, onChange }) {
  const { t } = useTranslation("common");
  const dependencies = node.dependencies
    .map((id) => parent.subgraph.nodes.find((item) => item.id === id))
    .filter(Boolean);

  const toggleSource = (dependencyId, source) => {
    const current = node.dependencyContext[dependencyId] ?? [
      "final_result",
      "deliveries",
    ];
    const next = current.includes(source)
      ? current.filter((item) => item !== source)
      : [...current, source];
    onChange("dependencyContext", {
      ...node.dependencyContext,
      [dependencyId]: next,
    });
  };

  return (
    <div className={automationClass("dag-stage-dependency-summary")}>
      <span>{t("automation.dependency.title")}</span>
      <div>
        {dependencies.length ? (
          dependencies.map((dependency) => (
            <div key={dependency.id}>
              <em>{dependency.name}</em>
              <div>
                {Object.entries(DEPENDENCY_CONTEXT_KEYS).map(
                  ([source, labelKey]) => (
                    <label key={source}>
                      <input
                        type="checkbox"
                        data-testid={`dag-stage-context-${node.id}-${dependency.id}-${source}`}
                        checked={(
                          node.dependencyContext[dependency.id] ?? [
                            "final_result",
                            "deliveries",
                          ]
                        ).includes(source)}
                        onChange={() => toggleSource(dependency.id, source)}
                      />
                      {t(labelKey)}
                    </label>
                  ),
                )}
              </div>
            </div>
          ))
        ) : (
          <small>{t("automation.dependency.start")}</small>
        )}
      </div>
      <p>{t("automation.dependency.hint")}</p>
    </div>
  );
}

function StepSettings({
  step,
  executionCatalog,
  onChange,
  onDelete,
  deleteButtonRef,
  onOpenPluginMenu,
  supplemental,
  constraint = false,
}) {
  const { t } = useTranslation("common");
  if (!step) return null;

  const environmentOptions = executionCatalog.environments.some(
    (option) => option.deviceId === step.executionDeviceId,
  )
    ? executionCatalog.environments
    : step.executionDeviceId
      ? [
          {
            deviceId: step.executionDeviceId,
            label: step.environment,
            executionEnvironment: step.executionEnvironment,
          },
          ...executionCatalog.environments,
        ]
      : executionCatalog.environments;
  const modelOptions = executionCatalog.models.some(
    (option) => option.name === step.model,
  )
    ? executionCatalog.models
    : step.model
      ? [
          {
            name: step.model,
            label: step.model,
            type: step.modelType,
            options: step.modelOptions,
          },
          ...executionCatalog.models,
        ]
      : executionCatalog.models;
  const configuredPluginOptions = [
    ...executionCatalog.plugins,
    ...step.plugins
      .filter(
        (label) =>
          !executionCatalog.plugins.some((option) => option.label === label),
      )
      .map((label) => ({
        id: label,
        label,
        reference: { displayName: label },
      })),
  ];
  const runtimeProfiles = executionCatalog.runtimeProfiles ?? [];

  const selectRuntimeProfile = (profileId) => {
    const profile = runtimeProfiles.find((item) => item.id === profileId);
    if (!profile) {
      onChange("runtimeProfileId", null);
      return;
    }
    onChange("runtimeProfileId", profile.id);
    onChange("executionDeviceId", profile.executionDeviceId);
    onChange("executionEnvironment", profile.executionEnvironment);
    onChange("environment", profile.name);
    onChange("model", profile.model);
    onChange("modelType", profile.modelType);
    onChange("modelOptions", profile.modelOptions);
  };

  const selectEnvironment = (deviceId) => {
    if (!deviceId) {
      clearExecutionEnvironment(onChange);
      return;
    }
    const option = environmentOptions.find(
      (candidate) => candidate.deviceId === deviceId,
    );
    if (!option) return;
    onChange("executionDeviceId", option.deviceId);
    onChange("executionEnvironment", option.executionEnvironment);
    onChange("environment", option.label);
    onChange("runtimeProfileId", null);
  };

  const selectModel = (name) => {
    if (!name) {
      clearExecutionModel(onChange);
      return;
    }
    const option = modelOptions.find((candidate) => candidate.name === name);
    if (!option) return;
    onChange("model", option.name);
    onChange("modelType", option.type);
    onChange("modelOptions", option.options);
    onChange("runtimeProfileId", null);
  };

  const togglePlugin = (option) => {
    const selected = step.plugins.includes(option.label);
    onChange(
      "plugins",
      selected
        ? step.plugins.filter((item) => item !== option.label)
        : [...step.plugins, option.label],
    );
    onChange(
      "projectPlugins",
      selected
        ? step.projectPlugins.filter((item) => item.id !== option.id)
        : [...step.projectPlugins, option.reference],
    );
  };

  const addDeliverable = () => {
    onChange("deliverables", [
      ...step.deliverables,
      {
        id: `deliverable-${Date.now()}`,
        name: t("automation.step.newDeliverable"),
        description: "",
        valueType: "text",
        fileConstraints: null,
      },
    ]);
  };

  const updateDeliverable = (id, key, value) => {
    onChange(
      "deliverables",
      step.deliverables.map((deliverable) =>
        deliverable.id === id ? { ...deliverable, [key]: value } : deliverable,
      ),
    );
  };

  const updateDeliverableType = (id, valueType) => {
    const deliverable = step.deliverables.find((item) => item.id === id);
    if (!deliverable) return;
    onChange(
      "deliverables",
      step.deliverables.map((item) =>
        item.id === id
          ? {
              ...item,
              valueType,
              fileConstraints:
                valueType === "file"
                  ? (deliverable.fileConstraints ?? {
                      accepted_types: [],
                      min_files: 1,
                      max_files: 1,
                    })
                  : null,
            }
          : item,
      ),
    );
  };

  return (
    <>
      <section className={automationClass("panel-section")}>
        <label className={automationClass("panel-field")}>
          <span>
            {t(
              constraint
                ? "automation.step.stageName"
                : "automation.step.nodeName",
            )}
          </span>
          <input
            data-testid={`execution-node-name-${step.id}`}
            value={step.name}
            placeholder={t(
              constraint
                ? "automation.step.stageNamePlaceholder"
                : "automation.step.nodeNamePlaceholder",
            )}
            onChange={(event) => onChange("name", event.target.value)}
          />
        </label>
        <label className={automationClass("panel-field")}>
          <span>
            <Code2 size={14} />
            {t(
              constraint
                ? "automation.step.stagePrompt"
                : "automation.step.nodePrompt",
            )}
          </span>
          <textarea
            data-testid={`execution-node-prompt-${step.id}`}
            value={step.prompt}
            placeholder={
              constraint
                ? t("automation.step.stagePromptPlaceholder")
                : t("automation.step.nodePromptPlaceholder")
            }
            onChange={(event) => onChange("prompt", event.target.value)}
          />
        </label>
      </section>

      <section className={automationClass("deliverables-section")}>
        <div className={automationClass("section-heading")}>
          <strong>{t("automation.step.deliverables")}</strong>
          <button
            type="button"
            data-testid={`execution-node-add-deliverable-${step.id}`}
            onClick={addDeliverable}
          >
            <Plus size={13} />
            {t("automation.step.addDeliverable")}
          </button>
        </div>
        {step.deliverables.length ? (
          <div className={automationClass("deliverable-list")}>
            {step.deliverables.map((deliverable) => (
              <div
                className={automationClass("deliverable-item")}
                key={deliverable.id}
              >
                <div>
                  <input
                    data-testid={`execution-node-deliverable-name-${deliverable.id}`}
                    value={deliverable.name}
                    aria-label={t("automation.step.deliverableName")}
                    onChange={(event) =>
                      updateDeliverable(
                        deliverable.id,
                        "name",
                        event.target.value,
                      )
                    }
                  />
                  <input
                    data-testid={`execution-node-deliverable-description-${deliverable.id}`}
                    value={deliverable.description}
                    aria-label={t("automation.step.deliverableAcceptance")}
                    placeholder={t("automation.step.noAcceptance")}
                    onChange={(event) =>
                      updateDeliverable(
                        deliverable.id,
                        "description",
                        event.target.value,
                      )
                    }
                  />
                </div>
                <select
                  data-testid={`execution-node-deliverable-type-${deliverable.id}`}
                  value={deliverable.valueType}
                  aria-label={t("automation.step.deliverableType", {
                    name: deliverable.name,
                  })}
                  onChange={(event) =>
                    updateDeliverableType(deliverable.id, event.target.value)
                  }
                >
                  {Object.entries(DELIVERABLE_TYPE_KEYS).map(
                    ([value, labelKey]) => (
                      <option key={value} value={value}>
                        {t(labelKey)}
                      </option>
                    ),
                  )}
                </select>
                <button
                  type="button"
                  data-testid={`execution-node-deliverable-delete-${deliverable.id}`}
                  aria-label={t("automation.step.deleteDeliverable", {
                    name: deliverable.name,
                  })}
                  onClick={() =>
                    onChange(
                      "deliverables",
                      step.deliverables.filter(
                        (item) => item.id !== deliverable.id,
                      ),
                    )
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <button
            className={automationClass("empty-deliverables")}
            type="button"
            data-testid={`execution-node-empty-deliverables-${step.id}`}
            onClick={addDeliverable}
          >
            {t("automation.step.emptyDeliverables")}
          </button>
        )}
        <p>{t("automation.step.deliverablesHint")}</p>
      </section>

      <section className={automationClass("panel-section execution-section")}>
        <fieldset className={automationClass("execution-mode")}>
          <legend>
            {t(
              constraint
                ? "automation.step.stageExecution"
                : "automation.step.taskExecution",
            )}
          </legend>
          <div>
            <button
              type="button"
              data-testid={`execution-node-mode-manual-${step.id}`}
              className={step.executionMode === "manual" ? "selected" : ""}
              onClick={() => onChange("executionMode", "manual")}
            >
              <UserRound size={16} />
              {t("automation.execution.manual")}
            </button>
            <button
              type="button"
              data-testid={`execution-node-mode-automatic-${step.id}`}
              className={step.executionMode === "automatic" ? "selected" : ""}
              onClick={() => onChange("executionMode", "automatic")}
            >
              <Bot size={16} />
              {t("automation.execution.automatic")}
            </button>
          </div>
        </fieldset>

        {!constraint && step.executionMode === "automatic" ? (
          <div className={automationClass("node-model-settings")}>
            {runtimeProfiles.length ? (
              <label className={automationClass("panel-field")}>
                <span>
                  <Settings2 size={14} />
                  {t("automation.execution.runtimeProfile")}
                </span>
                <select
                  data-testid={`execution-node-runtime-profile-${step.id}`}
                  value={step.runtimeProfileId ?? ""}
                  onChange={(event) => selectRuntimeProfile(event.target.value)}
                >
                  <option value="">
                    {t("automation.execution.customConfiguration")}
                  </option>
                  {runtimeProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={automationClass("panel-field")}>
              <span>
                <Laptop size={14} />
                {t("automation.step.environment")}
              </span>
              <ExecutionEnvironmentSelect
                testId={`execution-node-environment-${step.id}`}
                value={step.executionDeviceId ?? ""}
                options={environmentOptions}
                onChange={selectEnvironment}
              />
            </label>
            <label className={automationClass("panel-field")}>
              <span>
                <Sparkles size={14} />
                {t("automation.step.model")}
              </span>
              <select
                data-testid={`execution-node-model-${step.id}`}
                value={step.model}
                onChange={(event) => selectModel(event.target.value)}
              >
                <option value="">{t("automation.step.noModel")}</option>
                {modelOptions.map((option) => (
                  <option
                    key={`${option.type}-${option.name}`}
                    value={option.name}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={automationClass("panel-field")}>
              <span>
                <Puzzle size={14} />
                {t("automation.step.plugins")}
              </span>
              <PluginSelector
                testId={`execution-node-add-plugin-${step.id}`}
                selectedPlugins={step.plugins}
                options={configuredPluginOptions}
                onToggle={togglePlugin}
                onOpen={onOpenPluginMenu}
              />
            </div>
            <p className={automationClass("execution-hint")}>
              {t("automation.step.automaticHint")}
            </p>
          </div>
        ) : !constraint ? (
          <p className={automationClass("execution-hint")}>
            {t("automation.step.manualHint")}
          </p>
        ) : (
          <p className={automationClass("execution-hint")}>
            {t("automation.step.constraintHint")}
          </p>
        )}

        {!constraint ? (
          <label className={automationClass("panel-field")}>
            <span>{t("automation.step.workspace")}</span>
            <select
              data-testid={`execution-node-workspace-${step.id}`}
              value={step.workspacePolicy}
              onChange={(event) =>
                onChange("workspacePolicy", event.target.value)
              }
            >
              <option value="composer">
                {t("automation.step.workspaceComposer")}
              </option>
              <option value="inherit">
                {t("automation.step.workspaceInherit")}
              </option>
              <option value="none">{t("automation.step.workspaceNone")}</option>
            </select>
          </label>
        ) : null}

        <label className={automationClass("required-node")}>
          <input
            type="checkbox"
            data-testid={`execution-node-required-${step.id}`}
            checked={step.required}
            onChange={(event) => onChange("required", event.target.checked)}
          />
          {t("automation.step.required")}
        </label>

        <div className={automationClass("panel-help")}>
          <GitBranch size={15} />
          <p>
            {constraint
              ? t("automation.step.stageHint")
              : t("automation.step.nodeHint")}
          </p>
        </div>
      </section>
      {supplemental ? (
        <section className={automationClass("panel-section")}>
          {supplemental}
        </section>
      ) : null}
      <section className={automationClass("panel-danger-zone")}>
        <button
          ref={deleteButtonRef}
          className={automationClass("delete-step")}
          data-testid={`execution-node-delete-${step.id}`}
          onClick={onDelete}
        >
          <Trash2 size={14} />
          {t(
            constraint
              ? "automation.step.deleteStage"
              : "automation.step.deleteNode",
          )}
        </button>
      </section>
    </>
  );
}

function RunsHome({ runs, rules, loading, onOpenRule }) {
  const { t } = useTranslation("common");
  const [status, setStatus] = useState("all");
  const visibleRuns = runs.filter((run) =>
    runMatchesFilter(run.status, status),
  );

  return (
    <main className={automationClass("runs-home")}>
      <div className={automationClass("runs-title")}>
        <div>
          <h1>{t("automation.runs.title")}</h1>
          <p>{t("automation.runs.allDescription")}</p>
        </div>
        <div className={automationClass("run-filters")}>
          {[
            ["all", t("automation.filter.all")],
            ["active", t("automation.runs.active")],
            ["success", t("automation.status.succeeded")],
            ["failed", t("automation.status.failed")],
          ].map(([value, label]) => (
            <button
              key={value}
              className={status === value ? "active" : ""}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={automationClass("runs-table")}>
        <div className={automationClass("runs-table-head")}>
          <span>{t("automation.runs.automationAndIssue")}</span>
          <span>{t("automation.runs.status")}</span>
          <span>{t("automation.runs.startedAt")}</span>
          <span>{t("automation.runs.duration")}</span>
          <span />
        </div>
        {loading ? (
          <div
            className={automationClass("home-empty")}
            data-testid="automation-runs-loading"
          >
            <Activity className={automationClass("spin")} size={22} />
            <strong>{t("automation.editor.loadingRuns")}</strong>
          </div>
        ) : (
          visibleRuns.map((run) => (
            <div
              className={automationClass("runs-row")}
              data-testid={`automation-run-${run.id}`}
              key={run.id}
            >
              <span>
                <strong>{run.ruleName}</strong>
                <small>{run.issue}</small>
              </span>
              <RunStatus status={run.status} />
              <span>{run.startedAt}</span>
              <span>{run.duration}</span>
              <button
                data-testid={`automation-run-open-rule-${run.id}`}
                onClick={() => {
                  const rule = rules.find((item) => item.id === run.ruleId);
                  if (rule) onOpenRule(rule);
                }}
              >
                {t("automation.runs.openRule")}
              </button>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
