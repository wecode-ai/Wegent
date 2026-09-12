import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BaseEdge,
  Background,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  getBezierPath,
  useNodesState,
  useReactFlow,
  useStore,
  useViewport,
} from "@xyflow/react";
import {
  Box,
  ChevronRight,
  CircleDot,
  Clock3,
  Flag,
  Focus,
  GitBranch,
  Hand,
  Minus,
  MousePointer2,
  Plus,
  Repeat,
  Sparkles,
  Webhook,
} from "lucide-react";
import { useTranslation } from "./AutomationUiHost";
import { automationClass } from "./automationStyles";
import {
  canvasNodeIdToSelection,
  setCanvasEventBus,
  useCanvasEventBus,
} from "./canvasEventBus";
import { eventTypeLabel } from "./eventTypeLabel";
import {
  DYNAMIC_NODE_WIDTH,
  DYNAMIC_NODE_HEIGHT,
  GROUP_HEADER_HEIGHT,
  GROUP_MIN_WIDTH,
  LOOP_HEADER_HEIGHT,
  OUTER_NODE_HEIGHT,
  OUTER_NODE_WIDTH,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  branchNodeHeight,
  loopBodyNodeSize,
} from "./canvasGeometry";

const INSERT_ITEM_DEFS = {
  task: { Icon: Box },
  dynamic: { Icon: Sparkles },
  loop: { Icon: Repeat },
  branch: { Icon: Webhook },
  loopEnd: { Icon: Flag },
};

const TOP_LEVEL_INSERT_KINDS = ["task", "dynamic", "loop", "branch"];
const BRANCH_HANDLER_KINDS = TOP_LEVEL_INSERT_KINDS;
const LOOP_BODY_INSERT_KINDS = ["task", "branch", "loopEnd"];
const LOOP_BRANCH_HANDLER_KINDS = LOOP_BODY_INSERT_KINDS;

function selectNodeFromMouse(event, onSelect) {
  if (
    (event.button != null && event.button !== 0) ||
    (event.target instanceof Element && event.target.closest(".nodrag, .nopan"))
  ) {
    return;
  }
  onSelect();
}

const HorizontalHandles = ({ hidden = true }) => (
  <>
    <Handle
      type="target"
      position={Position.Left}
      className={automationClass(
        hidden ? "automation-hidden-handle" : "automation-node-handle",
      )}
    />
    <Handle
      type="source"
      position={Position.Right}
      className={automationClass(
        hidden ? "automation-hidden-handle" : "automation-node-handle",
      )}
    />
  </>
);

function withCanvasNodeSelection(Component) {
  const SelectionSyncedNode = memo(function SelectionSyncedNode(props) {
    const { selected, id } = props;
    const selectNode = useCanvasEventBus((eventBus) => eventBus.selectNode);
    const selectionId = useMemo(() => canvasNodeIdToSelection(id), [id]);

    useEffect(() => {
      if (selected) selectNode(selectionId);
    }, [selected, selectNode, selectionId]);

    return <Component {...props} />;
  });
  SelectionSyncedNode.displayName = `SelectionSyncedNode(${
    Component.displayName || Component.name || "CanvasNode"
  })`;
  return SelectionSyncedNode;
}

const WorkflowNodeInsertControl = memo(function WorkflowNodeInsertControl({
  nodeId,
  placement,
  kinds,
  onInsert,
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);

  return (
    <div
      className={automationClass(`workflow-node-insert ${placement}`)}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={automationClass("workflow-node-insert-trigger nodrag nopan")}
        data-testid={`automation-node-insert-${placement}-${nodeId}`}
        aria-label={t(
          placement === "before"
            ? "automation.canvas.insertBefore"
            : "automation.canvas.insertAfter",
        )}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={16} />
      </button>
      {open ? (
        <div
          className={automationClass(
            `workflow-node-insert-menu nodrag nopan ${placement}`,
          )}
        >
          {kinds.map((kind) => {
            const { Icon } = INSERT_ITEM_DEFS[kind];
            return (
              <button
                key={kind}
                type="button"
                data-testid={`automation-node-insert-${placement}-${kind}-${nodeId}`}
                onClick={() => {
                  onInsert(placement, kind);
                  setOpen(false);
                }}
              >
                <Icon size={14} />
                {t(`automation.node.${kind}`)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

const WorkflowNodeInsertControls = memo(function WorkflowNodeInsertControls({
  nodeId,
  allowBefore = true,
  kinds = TOP_LEVEL_INSERT_KINDS,
  onInsert,
}) {
  const { t } = useTranslation("common");
  return (
    <>
      {allowBefore ? (
        <WorkflowNodeInsertControl
          nodeId={nodeId}
          placement="before"
          kinds={kinds}
          onInsert={onInsert}
        />
      ) : null}
      <WorkflowNodeInsertControl
        nodeId={nodeId}
        placement="after"
        kinds={kinds}
        onInsert={onInsert}
      />
    </>
  );
});

const BranchContinuationControl = memo(function BranchContinuationControl({
  branchId,
  kinds,
  onInsertContinuation,
}) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  return (
    <div
      className={automationClass("react-flow-branch-continuation")}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={automationClass(
          "react-flow-branch-continuation-trigger nodrag nopan",
        )}
        data-testid={`branch-continuation-${branchId}`}
        aria-label={t("automation.canvas.addContinuation")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={12} />
      </button>
      {open ? (
        <div
          className={automationClass(
            "react-flow-branch-continuation-menu nodrag nopan",
          )}
        >
          {kinds.map((candidate) => {
            const { Icon } = INSERT_ITEM_DEFS[candidate];
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  onInsertContinuation(branchId, candidate);
                  setOpen(false);
                }}
              >
                <Icon size={13} />
                {t(`automation.node.${candidate}`)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

const TriggerCanvasNode = memo(function TriggerCanvasNode({ data, selected }) {
  const { t } = useTranslation("common");
  const TriggerIcon = data.triggerType === "schedule" ? Clock3 : Webhook;
  return (
    <article
      className={automationClass(
        `workflow-node-shell ${selected ? "selected" : ""}`,
      )}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, data.onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(
          `flow-node trigger ${selected ? "selected" : ""}`,
        )}
        data-testid="automation-trigger-node"
        onClick={data.onSelect}
      >
        <span className={automationClass("node-icon trigger")}>
          <TriggerIcon size={17} />
        </span>
        <span className={automationClass("flow-node-copy")}>
          <small>{t("automation.rule.trigger")}</small>
          <strong>{data.title}</strong>
          <span>{data.meta}</span>
        </span>
        <ChevronRight size={14} />
      </button>
      <WorkflowNodeInsertControls
        nodeId="trigger"
        allowBefore={false}
        onInsert={data.onInsert}
      />
    </article>
  );
});
const SelectionSyncedTriggerCanvasNode =
  withCanvasNodeSelection(TriggerCanvasNode);

function executionSummary(environment, model, t) {
  const normalizedEnvironment = /^(Local Executor|本机执行器)(\s*·.*)?$/i.test(
    environment,
  )
    ? t("automation.execution.local")
    : environment.replace(/\s*·\s*(在线|忙碌)$/, "");
  return (
    [normalizedEnvironment, model].filter(Boolean).join(" · ") ||
    t("automation.execution.unconfigured")
  );
}

const ExecutionCanvasNode = memo(function ExecutionCanvasNode({
  data,
  selected,
}) {
  const { t } = useTranslation("common");
  return (
    <article
      className={automationClass(
        `workflow-node-shell ${selected ? "selected" : ""}`,
      )}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, data.onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(
          `flow-node step ${selected ? "selected" : ""}`,
        )}
        data-testid={`execution-node-${data.step.id}`}
        onClick={data.onSelect}
      >
        <span className={automationClass("node-icon step")}>
          <Box size={17} />
        </span>
        <span className={automationClass("flow-node-copy")}>
          <small>
            {t(
              data.step.executionMode === "automatic"
                ? "automation.execution.automatic"
                : "automation.execution.manual",
            )}
          </small>
          <strong>{data.step.name || t("automation.node.unnamed")}</strong>
          <span>
            {data.step.executionMode === "automatic"
              ? executionSummary(data.step.environment, data.step.model, t)
              : t("automation.execution.manualMember")}
          </span>
        </span>
        <ChevronRight size={14} />
      </button>
      <WorkflowNodeInsertControls
        nodeId={data.step.id}
        onInsert={data.onInsert}
      />
    </article>
  );
});
const SelectionSyncedExecutionCanvasNode =
  withCanvasNodeSelection(ExecutionCanvasNode);

const DynamicCanvasNode = memo(function DynamicCanvasNode({ data, selected }) {
  const { t } = useTranslation("common");
  return (
    <article
      className={automationClass(
        `workflow-node-shell ${selected ? "selected" : ""}`,
      )}
      data-testid={`ai-allocation-node-${data.step.id}`}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, data.onSelect)}
    >
      <HorizontalHandles />
      <div
        className={automationClass(
          `dynamic-flow-node ${selected ? "selected" : ""}`,
        )}
      >
        <button
          type="button"
          className={automationClass("dynamic-node-main")}
          onClick={data.onSelect}
        >
          <span className={automationClass("node-icon coordinator")}>
            <Sparkles size={17} />
          </span>
          <span className={automationClass("flow-node-copy")}>
            <small>{t("automation.node.dynamicUnconstrained")}</small>
            <strong>{data.step.name}</strong>
            <span>
              {executionSummary(data.step.environment, data.step.model, t)}
            </span>
          </span>
        </button>
        <button
          type="button"
          className={automationClass("dynamic-node-add-stage nodrag nopan")}
          data-testid={`dag-stage-add-first-${data.step.id}`}
          aria-label={t("automation.canvas.addFirstStage")}
          onClick={data.onAddFirstStage}
        >
          <GitBranch size={13} />
          {t("automation.canvas.addConstraint")}
        </button>
      </div>
      <WorkflowNodeInsertControls
        nodeId={data.step.id}
        onInsert={data.onInsert}
      />
    </article>
  );
});
const SelectionSyncedDynamicCanvasNode =
  withCanvasNodeSelection(DynamicCanvasNode);

const DynamicGroupCanvasNode = memo(function DynamicGroupCanvasNode({
  data,
  selected,
}) {
  const { t } = useTranslation("common");
  return (
    <section
      className={automationClass(
        `react-flow-dynamic-group ${selected ? "selected" : ""}`,
      )}
      data-testid={`ai-allocation-node-${data.step.id}`}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, data.onSelect)}
    >
      <HorizontalHandles />
      <WorkflowNodeInsertControls
        nodeId={data.step.id}
        onInsert={data.onInsert}
      />
      <button
        type="button"
        className={automationClass("react-flow-group-header")}
        onClick={data.onSelect}
      >
        <span className={automationClass("node-icon coordinator")}>
          <Sparkles size={17} />
        </span>
        <span>
          <small>{t("automation.node.dynamicDag")}</small>
          <strong>{data.step.name}</strong>
          <em>{executionSummary(data.step.environment, data.step.model, t)}</em>
        </span>
        <span className={automationClass("subgraph-count")}>
          {t("automation.canvas.nodeCount", {
            count: data.step.subgraph?.nodes.length ?? 0,
          })}
        </span>
      </button>
      <div className={automationClass("react-flow-group-label")}>
        <GitBranch size={12} />
        {t("automation.canvas.dragHint")}
      </div>
    </section>
  );
});
const SelectionSyncedDynamicGroupCanvasNode = withCanvasNodeSelection(
  DynamicGroupCanvasNode,
);

const DagStageCanvasNode = memo(function DagStageCanvasNode({
  data,
  selected,
}) {
  const { t } = useTranslation("common");
  return (
    <article
      className={automationClass(
        `react-flow-stage-node ${selected ? "selected" : ""}`,
      )}
      data-testid={`dag-stage-container-${data.stage.id}`}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, data.onSelect)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={automationClass("react-flow-stage-handle target")}
      />
      <button
        type="button"
        className={automationClass("react-flow-stage-main")}
        data-testid={`dag-stage-node-${data.stage.id}`}
        onClick={data.onSelect}
      >
        <span>{data.index + 1}</span>
        <span>
          <strong>{data.stage.name}</strong>
          <small>
            {data.stage.dependencies.length
              ? t("automation.canvas.dependencyCount", {
                  count: data.stage.dependencies.length,
                })
              : data.stage.executionMode === "automatic"
                ? executionSummary(data.stage.environment, data.stage.model, t)
                : t("automation.execution.manual")}
          </small>
        </span>
      </button>
      <button
        type="button"
        className={automationClass(
          "react-flow-stage-insert before nodrag nopan",
        )}
        data-testid={`dag-stage-insert-before-${data.stage.id}`}
        aria-label={t("automation.canvas.insertStageBefore", {
          name: data.stage.name,
        })}
        onClick={(event) => {
          event.stopPropagation();
          data.onInsert("before");
        }}
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        className={automationClass(
          "react-flow-stage-insert after nodrag nopan",
        )}
        data-testid={`dag-stage-insert-after-${data.stage.id}`}
        aria-label={t("automation.canvas.insertStageAfter", {
          name: data.stage.name,
        })}
        onClick={(event) => {
          event.stopPropagation();
          data.onInsert("after");
        }}
      >
        <Plus size={12} />
      </button>
      <Handle
        type="source"
        position={Position.Right}
        className={automationClass("react-flow-stage-handle source")}
      />
    </article>
  );
});
const SelectionSyncedDagStageCanvasNode =
  withCanvasNodeSelection(DagStageCanvasNode);

const BranchConditionRows = memo(function BranchConditionRows({ step }) {
  const { t } = useTranslation("common");
  const conditions = step.branchConditions ?? [];
  return (
    <div className={automationClass("react-flow-branch-conditions")}>
      {conditions.length === 0 ? (
        <div className={automationClass("react-flow-branch-empty")}>
          {t("automation.canvas.emptyBranches")}
        </div>
      ) : (
        conditions.map((condition, index) => (
          <div
            className={automationClass("react-flow-branch-condition-row")}
            key={`${condition.eventType}-${index}`}
          >
            <em>{t("automation.canvas.branchIndex", { index: index + 1 })}</em>
            <span>
              {eventTypeLabel(condition.eventType, t) ||
                t("automation.canvas.noEvent")}
              <i>
                {t("automation.canvas.nodeCount", {
                  count: (condition.handlerNodeIds ?? []).length,
                })}
              </i>
            </span>
            <Handle
              type="source"
              id={`cond-${index}`}
              position={Position.Right}
              className={automationClass("react-flow-branch-handle")}
            />
          </div>
        ))
      )}
    </div>
  );
});

const BranchNodeHeader = memo(function BranchNodeHeader({
  step,
  testId,
  onSelect,
}) {
  const { t } = useTranslation("common");
  return (
    <button
      type="button"
      className={automationClass("react-flow-branch-header")}
      data-testid={testId}
      onClick={onSelect}
    >
      <span
        className={automationClass("node-icon branch", "!size-7 !rounded-md")}
      >
        <Webhook size={14} />
      </span>
      <span>
        <strong>{step.name || t("automation.node.branch")}</strong>
        <small>
          {t("automation.canvas.conditionCount", {
            count: (step.branchConditions ?? []).length,
          })}
        </small>
      </span>
    </button>
  );
});

const BranchCanvasNode = memo(function BranchCanvasNode({ data, selected }) {
  const { t } = useTranslation("common");
  const { step, onSelect, onAddBranchHandler, onAddBranchContinuation } = data;
  return (
    <article
      className={automationClass(
        `workflow-node-shell ${selected ? "selected" : ""}`,
      )}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, onSelect)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={automationClass("automation-hidden-handle")}
      />
      <div
        className={automationClass(
          `react-flow-branch-node ${selected ? "selected" : ""}`,
        )}
        data-testid={`branch-node-${step.id}`}
      >
        <BranchNodeHeader
          step={step}
          testId={`branch-node-main-${step.id}`}
          onSelect={onSelect}
        />
        <BranchConditionRows step={step} />
        <div className={automationClass("react-flow-branch-footer")}>
          <span>{t("automation.canvas.continue")}</span>
          <BranchContinuationControl
            branchId={step.id}
            kinds={BRANCH_HANDLER_KINDS}
            onInsertContinuation={onAddBranchContinuation}
          />
          <Handle
            type="source"
            id="default"
            position={Position.Right}
            className={automationClass("react-flow-branch-handle")}
          />
        </div>
      </div>
      <WorkflowNodeInsertControls
        nodeId={step.id}
        allowBefore={false}
        kinds={BRANCH_HANDLER_KINDS}
        onInsert={(placement, kind) =>
          onAddBranchHandler(step.id, { kind, eventType: "", select: "branch" })
        }
      />
    </article>
  );
});
const SelectionSyncedBranchCanvasNode =
  withCanvasNodeSelection(BranchCanvasNode);

const LoopBranchCanvasNode = memo(function LoopBranchCanvasNode({
  data,
  selected,
}) {
  const { t } = useTranslation("common");
  const { step, onSelect, onAddBranchHandler } = data;
  return (
    <article
      className={automationClass(
        `react-flow-branch-node ${selected ? "selected" : ""}`,
      )}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, onSelect)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={automationClass("automation-hidden-handle")}
      />
      <BranchNodeHeader
        step={step}
        testId={`loop-body-node-${step.id}`}
        onSelect={onSelect}
      />
      <BranchConditionRows step={step} />
      <WorkflowNodeInsertControls
        nodeId={step.id}
        allowBefore={false}
        kinds={LOOP_BODY_INSERT_KINDS}
        onInsert={(placement, kind) =>
          onAddBranchHandler(step.id, { kind, eventType: "", select: "branch" })
        }
      />
    </article>
  );
});
const SelectionSyncedLoopBranchCanvasNode =
  withCanvasNodeSelection(LoopBranchCanvasNode);

const LoopMarkerCanvasNode = memo(function LoopMarkerCanvasNode({
  data,
  selected,
}) {
  const { step, onSelect, onInsert } = data;
  const isStart = step.nodeType === "loopStart";
  return (
    <article
      className={automationClass(
        `react-flow-loop-marker-node ${selected ? "selected" : ""}`,
      )}
      title={
        step.name ||
        t(isStart ? "automation.node.loopStart" : "automation.node.loopEnd")
      }
      onMouseDownCapture={(event) => selectNodeFromMouse(event, onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(
          `react-flow-loop-marker-main ${isStart ? "start" : "end"} ${selected ? "selected" : ""}`,
        )}
        data-testid={`loop-body-node-${step.id}`}
        aria-label={
          step.name ||
          t(isStart ? "automation.node.loopStart" : "automation.node.loopEnd")
        }
        onClick={onSelect}
      >
        {isStart ? <CircleDot size={18} /> : <Flag size={16} />}
      </button>
      <WorkflowNodeInsertControls
        nodeId={step.id}
        allowBefore={false}
        kinds={LOOP_BODY_INSERT_KINDS}
        onInsert={onInsert}
      />
    </article>
  );
});
const SelectionSyncedLoopMarkerCanvasNode =
  withCanvasNodeSelection(LoopMarkerCanvasNode);

const LoopBodyCanvasNode = memo(function LoopBodyCanvasNode({
  data,
  selected,
}) {
  const { t } = useTranslation("common");
  const { step, onSelect, onInsert } = data;
  const caption =
    step.executionMode === "automatic"
      ? executionSummary(step.environment, step.model, t)
      : t("automation.execution.manual");
  return (
    <article
      className={automationClass(
        `react-flow-loop-body-node ${selected ? "selected" : ""}`,
      )}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass("react-flow-loop-body-main")}
        data-testid={`loop-body-node-${step.id}`}
        onClick={onSelect}
      >
        <span className={automationClass("node-icon")}>
          <Box size={14} />
        </span>
        <span>
          <strong>{step.name || t("automation.node.unnamed")}</strong>
          <small>{caption}</small>
        </span>
      </button>
      <WorkflowNodeInsertControls
        nodeId={step.id}
        allowBefore={false}
        kinds={LOOP_BODY_INSERT_KINDS}
        onInsert={onInsert}
      />
    </article>
  );
});
const SelectionSyncedLoopBodyCanvasNode =
  withCanvasNodeSelection(LoopBodyCanvasNode);

const LoopGroupCanvasNode = memo(function LoopGroupCanvasNode({
  id,
  data,
  selected,
}) {
  const { t } = useTranslation("common");
  const { step, onSelect, onInsert } = data;
  const childSelected = useStore(
    useCallback(
      (state) =>
        state.nodes.some((node) => node.parentId === id && node.selected),
      [id],
    ),
  );
  const highlighted = selected || childSelected;
  const loopConfig = step.loopConfig ?? {
    maxAttempts: 5,
    timeoutSeconds: null,
  };
  const attemptSummary =
    (loopConfig.maxAttempts ?? 5) === 0
      ? t("automation.execution.unlimited")
      : t("automation.execution.maxAttempts", {
          count: loopConfig.maxAttempts ?? 5,
        });
  const timeoutSummary = loopConfig.timeoutSeconds
    ? t("automation.execution.timeout", {
        seconds: loopConfig.timeoutSeconds,
      })
    : "";
  return (
    <section
      className={automationClass(
        `react-flow-loop-group ${highlighted ? "selected" : ""}`,
      )}
      data-testid={`loop-node-${step.id}`}
      onMouseDownCapture={(event) => selectNodeFromMouse(event, onSelect)}
    >
      <HorizontalHandles />
      <WorkflowNodeInsertControls nodeId={step.id} onInsert={onInsert} />
      <div className={automationClass("react-flow-loop-body-area")} />
      <div className={automationClass("react-flow-loop-header")}>
        <button
          type="button"
          className={automationClass("react-flow-loop-header-main")}
          data-testid={`loop-node-main-${step.id}`}
          onClick={onSelect}
        >
          <span className={automationClass("node-icon coordinator")}>
            <Repeat size={15} />
          </span>
          <span>
            <small>{t("automation.node.loop")}</small>
            <strong>{step.name || t("automation.node.unnamedLoop")}</strong>
            <em>
              {attemptSummary}
              {timeoutSummary}
            </em>
          </span>
        </button>
      </div>
    </section>
  );
});
const SelectionSyncedLoopGroupCanvasNode =
  withCanvasNodeSelection(LoopGroupCanvasNode);

const DifyStyleEdge = memo(function DifyStyleEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
}) {
  const [hovered, setHovered] = useState(false);
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
    curvature: 0.3,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke:
            selected || hovered
              ? "rgb(var(--color-focus))"
              : "rgb(var(--color-text-muted) / 0.58)",
          strokeWidth: selected || hovered ? 2.4 : 2,
          transition: "stroke 120ms ease, stroke-width 120ms ease",
        }}
      />
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
    </>
  );
});

const DifyConnectionLine = memo(function DifyConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
}) {
  const [edgePath] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: Position.Right,
    targetX: toX,
    targetY: toY,
    targetPosition: Position.Left,
    curvature: 0.3,
  });
  return (
    <g>
      <path
        fill="none"
        stroke="rgb(var(--color-text-muted) / 0.58)"
        strokeWidth={2}
        d={edgePath}
      />
      <rect
        x={toX - 1}
        y={toY - 4}
        width={2}
        height={8}
        fill="rgb(var(--color-focus))"
      />
    </g>
  );
});

const nodeTypes = {
  trigger: SelectionSyncedTriggerCanvasNode,
  execution: SelectionSyncedExecutionCanvasNode,
  dynamic: SelectionSyncedDynamicCanvasNode,
  dynamicGroup: SelectionSyncedDynamicGroupCanvasNode,
  dagStage: SelectionSyncedDagStageCanvasNode,
  branch: SelectionSyncedBranchCanvasNode,
  loopGroup: SelectionSyncedLoopGroupCanvasNode,
  loopBranch: SelectionSyncedLoopBranchCanvasNode,
  loopMarker: SelectionSyncedLoopMarkerCanvasNode,
  loopBody: SelectionSyncedLoopBodyCanvasNode,
};

const edgeTypes = {
  dify: DifyStyleEdge,
};

const CANVAS_FIT_PADDING = {
  top: "72px",
  right: "96px",
  bottom: "72px",
  left: "260px",
};

const CanvasViewportControls = memo(function CanvasViewportControls() {
  const { t } = useTranslation("common");
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const { zoom } = useViewport();

  return (
    <Panel
      position="bottom-right"
      className={automationClass("canvas-viewport-controls")}
    >
      <button
        type="button"
        aria-label={t("automation.canvas.zoomOut")}
        data-testid="automation-canvas-zoom-out"
        onClick={() => zoomOut({ duration: 160 })}
      >
        <Minus size={16} />
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        aria-label={t("automation.canvas.zoomIn")}
        data-testid="automation-canvas-zoom-in"
        onClick={() => zoomIn({ duration: 160 })}
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        aria-label={t("automation.canvas.fitView")}
        data-testid="automation-canvas-fit-view"
        onClick={() => fitView({ duration: 240, padding: CANVAS_FIT_PADDING })}
      >
        <Focus size={16} />
      </button>
    </Panel>
  );
});

function focusedViewport(node, viewport, canvasRect, rightPanelInset) {
  const visibleCenter = {
    x: Math.max(0, canvasRect.width - rightPanelInset) / 2,
    y: canvasRect.height / 2,
  };
  const nodeWidth =
    node.measured?.width ?? node.width ?? node.style?.width ?? OUTER_NODE_WIDTH;
  const nodeHeight =
    node.measured?.height ??
    node.height ??
    node.style?.height ??
    OUTER_NODE_HEIGHT;
  const nodeCenter = {
    x: node.position.x + nodeWidth / 2,
    y: node.position.y + nodeHeight / 2,
  };

  return {
    x: visibleCenter.x - nodeCenter.x * viewport.zoom,
    y: visibleCenter.y - nodeCenter.y * viewport.zoom,
    zoom: viewport.zoom,
  };
}

function nodeWithAbsolutePosition(node, nodesById) {
  let parentId = node.parentId;
  let x = node.position.x;
  let y = node.position.y;
  const visited = new Set([node.id]);

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodesById.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }

  return {
    ...node,
    position: { x, y },
  };
}

function selectedCanvasNodeId(selectedNode) {
  if (selectedNode.type === "trigger") return "trigger";
  if (selectedNode.type === "step") return selectedNode.id;
  if (selectedNode.type === "dagStage")
    return `dag:${selectedNode.stepId}:${selectedNode.stageId}`;
  if (selectedNode.type === "loopBody")
    return `loop:${selectedNode.loopId}:${selectedNode.bodyId}`;
  return null;
}

const CanvasViewportFocus = memo(function CanvasViewportFocus({
  canvasRef,
  nodes,
  rightPanelInset,
  selectedNode,
}) {
  const { getViewport, setViewport } = useReactFlow();
  const previousNodeIds = useRef(new Set(nodes.map((node) => node.id)));
  const previousRightPanelInset = useRef(rightPanelInset);
  const previousSelectedId = useRef(selectedCanvasNodeId(selectedNode));

  useLayoutEffect(() => {
    const previousIds = previousNodeIds.current;
    const priorSelectedId = previousSelectedId.current;
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const panelOpened =
      previousRightPanelInset.current === 0 && rightPanelInset > 0;
    const addedNode =
      selectedNode.type === "step" && !previousIds.has(selectedNode.id)
        ? nodes.find((node) => node.id === selectedNode.id)
        : nodes.find((node) => !previousIds.has(node.id));
    const selectedId = selectedCanvasNodeId(selectedNode);
    const selectedAfterDeletion =
      priorSelectedId !== null &&
      priorSelectedId !== selectedId &&
      !nodes.some((node) => node.id === priorSelectedId);
    const targetNode =
      addedNode ??
      (panelOpened || selectedAfterDeletion
        ? nodes.find((node) => node.id === selectedId)
        : undefined);
    previousNodeIds.current = new Set(nodes.map((node) => node.id));
    previousRightPanelInset.current = rightPanelInset;
    previousSelectedId.current = selectedId;
    if (!targetNode) return undefined;

    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const absoluteTargetNode = nodeWithAbsolutePosition(targetNode, nodesById);
    void setViewport(
      focusedViewport(
        absoluteTargetNode,
        getViewport(),
        canvas.getBoundingClientRect(),
        rightPanelInset,
      ),
      { duration: 240 },
    );
    return undefined;
  }, [
    canvasRef,
    getViewport,
    nodes,
    rightPanelInset,
    selectedNode,
    setViewport,
  ]);

  return null;
});

function createsCycle(nodes, sourceId, targetId) {
  if (sourceId === targetId) return true;
  const dependencies = new Map(
    nodes.map((node) => [node.id, node.dependencies]),
  );
  const visited = new Set();
  const visit = (stageId) => {
    if (stageId === targetId) return true;
    if (visited.has(stageId)) return false;
    visited.add(stageId);
    return (dependencies.get(stageId) ?? []).some(visit);
  };
  return visit(sourceId);
}

export function AutomationWorkflowCanvas({
  draft,
  trigger,
  selectedNode,
  rightPanelInset,
  onSelectNode,
  onInsertNode,
  onAddBranchHandler,
  onAddBranchContinuation,
  onAddDagStage,
  onToggleDagDependency,
  onMoveDagStage,
  onToggleStepDependency,
  onMoveStep,
  onInsertLoopBodyNode,
  onToggleLoopBodyDependency,
  onMoveLoopBodyNode,
  onDeleteNode,
}) {
  const { t } = useTranslation("common");
  const [interactionMode, setInteractionMode] = useState("pointer");
  const canvasRef = useRef(null);
  const onSelectNodeRef = useRef(onSelectNode);
  onSelectNodeRef.current = onSelectNode;

  useEffect(() => {
    setCanvasEventBus({
      selectNode: (selection) => onSelectNodeRef.current(selection),
    });
  }, []);

  const graph = useMemo(() => {
    const nodes = [];
    const edges = [];
    const centerY = 270;
    const stepIds = new Set(draft.steps.map((step) => step.id));

    nodes.push({
      id: "trigger",
      type: "trigger",
      position: {
        x: 80,
        y: centerY - OUTER_NODE_HEIGHT / 2,
      },
      data: {
        triggerType: draft.trigger.type,
        title: trigger.label,
        meta: trigger.detail,
        onSelect: () => onSelectNode({ type: "trigger" }),
        onInsert: (placement, kind) => onInsertNode(null, placement, kind),
      },
      style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
    });

    draft.steps.forEach((step, index) => {
      const stepX = Number.isFinite(step.x) ? step.x : 440 + index * 420;
      const stepY = Number.isFinite(step.y)
        ? step.y
        : centerY - OUTER_NODE_HEIGHT / 2;

      if (step.kind === "dynamic") {
        const subgraphNodes = step.subgraph?.nodes ?? [];
        if (subgraphNodes.length === 0) {
          nodes.push({
            id: step.id,
            type: "dynamic",
            position: {
              x: stepX,
              y: stepY,
            },
            data: {
              step,
              onSelect: () => onSelectNode({ type: "step", id: step.id }),
              onInsert: (placement, kind) =>
                onInsertNode(step.id, placement, kind),
              onAddFirstStage: () => onAddDagStage(step.id),
            },
            style: { width: DYNAMIC_NODE_WIDTH, height: DYNAMIC_NODE_HEIGHT },
          });
        } else {
          const graphWidth = Math.max(
            GROUP_MIN_WIDTH,
            ...subgraphNodes.map((stage) => (stage.x ?? 0) + STAGE_WIDTH + 40),
          );
          const graphHeight = Math.max(
            280,
            ...subgraphNodes.map((stage) => (stage.y ?? 0) + STAGE_HEIGHT + 36),
          );
          const groupHeight = GROUP_HEADER_HEIGHT + graphHeight;
          nodes.push({
            id: step.id,
            type: "dynamicGroup",
            position: {
              x: stepX,
              y: stepY,
            },
            data: {
              step,
              onSelect: () => onSelectNode({ type: "step", id: step.id }),
              onInsert: (placement, kind) =>
                onInsertNode(step.id, placement, kind),
            },
            style: { width: graphWidth, height: groupHeight },
          });

          subgraphNodes.forEach((stage, stageIndex) => {
            const stageNodeId = `dag:${step.id}:${stage.id}`;
            nodes.push({
              id: stageNodeId,
              type: "dagStage",
              parentId: step.id,
              extent: "parent",
              position: {
                x: (stage.x ?? 0) + 20,
                y: (stage.y ?? 0) + GROUP_HEADER_HEIGHT,
              },
              data: {
                stepId: step.id,
                stage,
                index: stageIndex,
                onSelect: () =>
                  onSelectNode({
                    type: "dagStage",
                    stepId: step.id,
                    stageId: stage.id,
                  }),
                onInsert: (placement) =>
                  onAddDagStage(step.id, stage.id, placement),
              },
              style: { width: STAGE_WIDTH, height: STAGE_HEIGHT },
            });
          });

          subgraphNodes.forEach((stage) => {
            stage.dependencies.forEach((dependencyId) => {
              edges.push({
                id: `dag-edge:${step.id}:${dependencyId}:${stage.id}`,
                source: `dag:${step.id}:${dependencyId}`,
                target: `dag:${step.id}:${stage.id}`,
                type: "dify",
                data: {
                  kind: "dag",
                  stepId: step.id,
                  sourceStageId: dependencyId,
                  targetStageId: stage.id,
                },
              });
            });
          });
        }
      } else if (step.kind === "loop") {
        const bodySteps = step.subgraph?.nodes ?? [];
        const graphWidth = Math.max(
          GROUP_MIN_WIDTH,
          ...bodySteps.map(
            (bodyStep) =>
              (bodyStep.x ?? 0) + loopBodyNodeSize(bodyStep).width + 56,
          ),
        );
        const graphHeight = Math.max(
          220,
          ...bodySteps.map(
            (bodyStep) =>
              (bodyStep.y ?? 0) + loopBodyNodeSize(bodyStep).height + 48,
          ),
        );
        const groupHeight = LOOP_HEADER_HEIGHT + graphHeight;
        nodes.push({
          id: step.id,
          type: "loopGroup",
          position: {
            x: stepX,
            y: stepY,
          },
          data: {
            step,
            onSelect: () => onSelectNode({ type: "step", id: step.id }),
            onInsert: (placement, kind) =>
              onInsertNode(step.id, placement, kind),
          },
          style: { width: graphWidth, height: groupHeight },
        });
        bodySteps.forEach((bodyStep) => {
          const bodyNodeId = `loop:${step.id}:${bodyStep.id}`;
          const bodySize = loopBodyNodeSize(bodyStep);
          const bodyType =
            bodyStep.nodeType === "branch"
              ? "loopBranch"
              : bodyStep.nodeType === "loopStart" ||
                  bodyStep.nodeType === "loopEnd"
                ? "loopMarker"
                : "loopBody";
          nodes.push({
            id: bodyNodeId,
            type: bodyType,
            parentId: step.id,
            extent: "parent",
            position: {
              x: (bodyStep.x ?? 0) + 20,
              y: (bodyStep.y ?? 0) + LOOP_HEADER_HEIGHT,
            },
            data: {
              step: bodyStep,
              loopId: step.id,
              onSelect: () =>
                onSelectNode({
                  type: "loopBody",
                  loopId: step.id,
                  bodyId: bodyStep.id,
                }),
              onInsert: (placement, kind) =>
                onInsertLoopBodyNode(step.id, bodyStep.id, placement, kind),
              onAddBranchHandler,
            },
            style: { width: bodySize.width, height: bodySize.height },
          });
        });
        bodySteps.forEach((bodyStep) => {
          (bodyStep.dependencies ?? []).forEach((dependencyId) => {
            const dependency = bodySteps.find(
              (candidate) => candidate.id === dependencyId,
            );
            if (!dependency || dependency.nodeType === "branch") return;
            edges.push({
              id: `loop-edge:${step.id}:${dependencyId}:${bodyStep.id}`,
              source: `loop:${step.id}:${dependencyId}`,
              target: `loop:${step.id}:${bodyStep.id}`,
              type: "dify",
              data: {
                kind: "loopBody",
                loopId: step.id,
                sourceBodyId: dependencyId,
                targetBodyId: bodyStep.id,
              },
            });
          });
        });
        bodySteps
          .filter((bodyStep) => bodyStep.nodeType === "branch")
          .forEach((branchStep) => {
            (branchStep.branchConditions ?? []).forEach(
              (condition, conditionIndex) => {
                (condition.handlerNodeIds ?? []).forEach((handlerId) => {
                  if (
                    !bodySteps.some((candidate) => candidate.id === handlerId)
                  )
                    return;
                  edges.push({
                    id: `branch-edge:${step.id}:${branchStep.id}:${conditionIndex}:${handlerId}`,
                    source: `loop:${step.id}:${branchStep.id}`,
                    sourceHandle: `cond-${conditionIndex}`,
                    target: `loop:${step.id}:${handlerId}`,
                    type: "dify",
                    selectable: false,
                    deletable: false,
                    data: { kind: "branchHandler" },
                  });
                });
              },
            );
          });
      } else if (step.kind === "branch") {
        nodes.push({
          id: step.id,
          type: "branch",
          position: {
            x: stepX,
            y: stepY,
          },
          data: {
            step,
            onSelect: () => onSelectNode({ type: "step", id: step.id }),
            onAddBranchHandler,
            onAddBranchContinuation,
          },
          style: {
            width: OUTER_NODE_WIDTH,
            height: branchNodeHeight(step, { footer: true }),
          },
        });
      } else {
        nodes.push({
          id: step.id,
          type: "execution",
          position: {
            x: stepX,
            y: stepY,
          },
          data: {
            step,
            onSelect: () => onSelectNode({ type: "step", id: step.id }),
            onInsert: (placement, kind) =>
              onInsertNode(step.id, placement, kind),
          },
          style: { width: OUTER_NODE_WIDTH, height: OUTER_NODE_HEIGHT },
        });
      }

      const dependencies = step.dependencies.filter((dependencyId) =>
        stepIds.has(dependencyId),
      );
      const sources = dependencies.length ? dependencies : ["trigger"];
      sources.forEach((sourceId) => {
        const sourceStep = draft.steps.find(
          (candidate) => candidate.id === sourceId,
        );
        if (sourceStep?.kind === "branch") {
          const isConditionHandler = (sourceStep.branchConditions ?? []).some(
            (condition) => (condition.handlerNodeIds ?? []).includes(step.id),
          );
          if (isConditionHandler) return;
        }
        edges.push({
          id: `outer-edge:${sourceId}:${step.id}`,
          source: sourceId,
          sourceHandle: sourceStep?.kind === "branch" ? "default" : undefined,
          target: step.id,
          type: "dify",
          selectable: sourceId !== "trigger",
          data: {
            kind: sourceId === "trigger" ? "trigger" : "outerDependency",
            sourceStepId: sourceId,
            targetStepId: step.id,
          },
        });
      });
      if (step.kind === "branch") {
        (step.branchConditions ?? []).forEach((condition, conditionIndex) => {
          (condition.handlerNodeIds ?? []).forEach((handlerId) => {
            if (!stepIds.has(handlerId)) return;
            edges.push({
              id: `branch-edge:${step.id}:${conditionIndex}:${handlerId}`,
              source: step.id,
              sourceHandle: `cond-${conditionIndex}`,
              target: handlerId,
              type: "dify",
              selectable: false,
              deletable: false,
              data: { kind: "branchHandler" },
            });
          });
        });
      }
    });

    return { nodes, edges };
  }, [
    draft,
    onAddBranchContinuation,
    onAddBranchHandler,
    onAddDagStage,
    onInsertLoopBodyNode,
    onInsertNode,
    onSelectNode,
    trigger.detail,
    trigger.label,
  ]);

  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);

  // Mirror the editor's selection model onto React Flow's native node
  // selection. Unchanged nodes keep object identity so only the two nodes
  // whose selection actually flips re-render.
  useEffect(() => {
    const selectedId =
      selectedNode.type === "trigger"
        ? "trigger"
        : selectedNode.type === "step"
          ? selectedNode.id
          : selectedNode.type === "dagStage"
            ? `dag:${selectedNode.stepId}:${selectedNode.stageId}`
            : selectedNode.type === "loopBody"
              ? `loop:${selectedNode.loopId}:${selectedNode.bodyId}`
              : null;
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.selected === (node.id === selectedId)
          ? node
          : { ...node, selected: node.id === selectedId },
      ),
    );
  }, [selectedNode, setNodes]);

  useEffect(() => {
    setNodes((currentNodes) => {
      const currentById = new Map(currentNodes.map((node) => [node.id, node]));
      return graph.nodes.map((node) => {
        const current = currentById.get(node.id);
        if (!current) return node;

        // The graph derived from the draft is the single source of truth for
        // node layout. React Flow only owns transient interaction state
        // (selection, drag-in-progress); never let its already-rendered
        // positions shadow an edited draft, otherwise newly inserted nodes
        // stack on top of pre-existing ones because the stale position wins.
        return {
          ...node,
          position: current.dragging ? current.position : node.position,
          selected: current.selected,
          dragging: current.dragging,
        };
      });
    });
  }, [graph.nodes, setNodes]);

  const onNodeDragStop = useCallback(
    (_, node) => {
      if (node.type === "dagStage") {
        node.data.onSelect?.();
        const { stepId, stage } = node.data;
        onMoveDagStage(
          stepId,
          stage.id,
          Math.max(0, Math.round(node.position.x - 20)),
          Math.max(0, Math.round(node.position.y - GROUP_HEADER_HEIGHT)),
        );
        return;
      }
      if (
        node.type === "loopBody" ||
        node.type === "loopBranch" ||
        node.type === "loopMarker"
      ) {
        node.data.onSelect?.();
        const { loopId, step } = node.data;
        onMoveLoopBodyNode(
          loopId,
          step.id,
          Math.max(0, Math.round(node.position.x - 20)),
          Math.max(0, Math.round(node.position.y - LOOP_HEADER_HEIGHT)),
        );
        return;
      }
      if (
        node.type === "execution" ||
        node.type === "dynamic" ||
        node.type === "dynamicGroup" ||
        node.type === "loopGroup" ||
        node.type === "branch"
      ) {
        node.data.onSelect?.();
        onMoveStep(
          node.id,
          Math.round(node.position.x),
          Math.round(node.position.y),
        );
      }
    },
    [onMoveDagStage, onMoveLoopBodyNode, onMoveStep],
  );

  const onConnect = useCallback(
    (connection) => {
      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      // Branch condition handles only route through settings; the default
      // handle carries the continuation dependency.
      if (sourceNode?.type === "loopBranch") {
        return;
      }
      if (
        sourceNode?.type === "branch" &&
        connection.sourceHandle !== "default"
      ) {
        return;
      }
      if (
        sourceNode?.type === "dagStage" &&
        targetNode?.type === "dagStage" &&
        sourceNode.data.stepId === targetNode.data.stepId
      ) {
        const step = draft.steps.find(
          (item) => item.id === sourceNode.data.stepId,
        );
        const subgraphNodes = step?.subgraph?.nodes ?? [];
        if (
          !step ||
          createsCycle(
            subgraphNodes,
            sourceNode.data.stage.id,
            targetNode.data.stage.id,
          ) ||
          targetNode.data.stage.dependencies.includes(sourceNode.data.stage.id)
        ) {
          return;
        }
        onToggleDagDependency(
          step.id,
          targetNode.data.stage.id,
          sourceNode.data.stage.id,
        );
        return;
      }
      if (
        sourceNode?.type !== "execution" &&
        sourceNode?.type !== "dynamic" &&
        sourceNode?.type !== "dynamicGroup" &&
        sourceNode?.type !== "branch" &&
        sourceNode?.type !== "loopBranch" &&
        sourceNode?.type !== "loopMarker" &&
        sourceNode?.type !== "loopBody"
      ) {
        return;
      }
      if (
        targetNode?.type !== "execution" &&
        targetNode?.type !== "dynamic" &&
        targetNode?.type !== "dynamicGroup" &&
        targetNode?.type !== "branch" &&
        targetNode?.type !== "loopBranch" &&
        targetNode?.type !== "loopMarker" &&
        targetNode?.type !== "loopBody"
      ) {
        return;
      }
      if (
        (sourceNode?.type === "loopBody" ||
          sourceNode?.type === "loopBranch" ||
          sourceNode?.type === "loopMarker") &&
        (targetNode?.type === "loopBody" ||
          targetNode?.type === "loopBranch" ||
          targetNode?.type === "loopMarker") &&
        sourceNode.data.loopId === targetNode.data.loopId
      ) {
        const loop = draft.steps.find(
          (item) => item.id === sourceNode.data.loopId,
        );
        const bodyNodes = loop?.subgraph?.nodes ?? [];
        if (
          !loop ||
          createsCycle(
            bodyNodes,
            sourceNode.data.step.id,
            targetNode.data.step.id,
          ) ||
          targetNode.data.step.dependencies.includes(sourceNode.data.step.id)
        ) {
          return;
        }
        onToggleLoopBodyDependency(
          loop.id,
          targetNode.data.step.id,
          sourceNode.data.step.id,
        );
        return;
      }
      const targetStep = draft.steps.find((step) => step.id === targetNode.id);
      if (
        !targetStep ||
        createsCycle(draft.steps, sourceNode.id, targetNode.id) ||
        targetStep.dependencies.includes(sourceNode.id)
      ) {
        return;
      }
      onToggleStepDependency(targetNode.id, sourceNode.id);
    },
    [
      draft.steps,
      nodes,
      onToggleDagDependency,
      onToggleLoopBodyDependency,
      onToggleStepDependency,
    ],
  );

  const onEdgesDelete = useCallback(
    (edges) => {
      edges.forEach((edge) => {
        if (edge.data?.kind === "dag") {
          onToggleDagDependency(
            edge.data.stepId,
            edge.data.targetStageId,
            edge.data.sourceStageId,
          );
        }
        if (edge.data?.kind === "loopBody") {
          onToggleLoopBodyDependency(
            edge.data.loopId,
            edge.data.targetBodyId,
            edge.data.sourceBodyId,
          );
        }
        if (edge.data?.kind === "outerDependency") {
          onToggleStepDependency(
            edge.data.targetStepId,
            edge.data.sourceStepId,
          );
        }
      });
    },
    [onToggleDagDependency, onToggleLoopBodyDependency, onToggleStepDependency],
  );

  const onNodesDelete = useCallback(
    (nodes) => {
      nodes.forEach((node) => onDeleteNode(node));
    },
    [onDeleteNode],
  );

  return (
    <div
      ref={canvasRef}
      className={automationClass("react-flow-workflow-canvas")}
      data-testid="automation-workflow-canvas"
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            ".react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__minimap",
          )
        ) {
          return;
        }
        onSelectNode({ type: "none" });
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(event, node) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".nodrag, .nopan")
          ) {
            return;
          }
          node.data.onSelect?.();
        }}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        connectionLineComponent={DifyConnectionLine}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        panOnDrag={interactionMode === "hand" ? true : [1, 2]}
        panOnScroll
        panOnScrollSpeed={0.72}
        selectionOnDrag={interactionMode === "pointer"}
        selectionMode={SelectionMode.Partial}
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        minZoom={0.25}
        maxZoom={1.8}
        defaultViewport={{ x: 176, y: 136, zoom: 0.99 }}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={["Backspace", "Delete"]}
      >
        <CanvasViewportFocus
          canvasRef={canvasRef}
          nodes={graph.nodes}
          rightPanelInset={rightPanelInset}
          selectedNode={selectedNode}
        />
        <Background
          variant="dots"
          gap={[18, 18]}
          size={1.2}
          color="rgb(var(--color-text-muted) / 0.28)"
        />
        <Panel
          position="top-left"
          className={automationClass("canvas-mode-controls")}
        >
          <button
            type="button"
            className={automationClass(
              "canvas-mode-button",
              interactionMode === "pointer" && "active",
            )}
            aria-label={t("automation.canvas.select")}
            data-testid="automation-canvas-pointer-mode"
            onClick={() => setInteractionMode("pointer")}
          >
            <MousePointer2 size={16} />
          </button>
          <button
            type="button"
            className={automationClass(
              "canvas-mode-button",
              interactionMode === "hand" && "active",
            )}
            aria-label={t("automation.canvas.pan")}
            data-testid="automation-canvas-hand-mode"
            onClick={() => setInteractionMode("hand")}
          >
            <Hand size={16} />
          </button>
        </Panel>
        <MiniMap
          className={automationClass("canvas-minimap")}
          pannable
          zoomable
          position="bottom-right"
          nodeColor={(node) =>
            node.type === "trigger"
              ? "rgb(var(--color-focus))"
              : node.type === "dynamicGroup"
                ? "rgb(var(--color-text-secondary) / 0.5)"
                : "rgb(var(--color-text-muted) / 0.5)"
          }
          maskColor="rgb(var(--color-bg-base) / 0.76)"
        />
        <CanvasViewportControls />
      </ReactFlow>
    </div>
  );
}
