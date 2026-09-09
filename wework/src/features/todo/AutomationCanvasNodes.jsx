import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import { Box, ChevronRight, CircleDot, Clock3, Flag, Plus, Repeat, Webhook } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { automationClass } from './automationStyles'
import { canvasNodeIdToSelection, useCanvasEventBus } from './canvasEventBus'
import { eventTypeLabel } from './eventTypeLabel'
const INSERT_ITEM_DEFS = {
  task: { label: '执行任务', Icon: Box },
  loop: { label: '循环', Icon: Repeat },
  branch: { label: '分支', Icon: Webhook },
  loopEnd: { label: '循环结束', Icon: Flag },
}

const TOP_LEVEL_INSERT_KINDS = ['task', 'loop', 'branch']
const BRANCH_HANDLER_KINDS = TOP_LEVEL_INSERT_KINDS
const LOOP_BODY_INSERT_KINDS = ['task', 'branch', 'loopEnd']
const LOOP_BRANCH_HANDLER_KINDS = LOOP_BODY_INSERT_KINDS

function selectNodeFromMouse(event, onSelect) {
  if (
    (event.button != null && event.button !== 0) ||
    (event.target instanceof Element && event.target.closest('.nodrag, .nopan'))
  ) {
    return
  }
  onSelect()
}

const HorizontalHandles = ({ hidden = true }) => (
  <>
    <Handle
      type="target"
      position={Position.Left}
      className={automationClass(hidden ? 'automation-hidden-handle' : 'automation-node-handle')}
    />
    <Handle
      type="source"
      position={Position.Right}
      className={automationClass(hidden ? 'automation-hidden-handle' : 'automation-node-handle')}
    />
  </>
)

function withCanvasNodeSelection(Component) {
  const SelectionSyncedNode = memo(function SelectionSyncedNode(props) {
    const { selected, id } = props
    const selectNode = useCanvasEventBus(eventBus => eventBus.selectNode)
    const selectionId = useMemo(() => canvasNodeIdToSelection(id), [id])

    useEffect(() => {
      if (selected) selectNode(selectionId)
    }, [selected, selectNode, selectionId])

    return <Component {...props} />
  })
  SelectionSyncedNode.displayName = `SelectionSyncedNode(${
    Component.displayName || Component.name || 'CanvasNode'
  })`
  return SelectionSyncedNode
}

const WorkflowNodeInsertControl = memo(function WorkflowNodeInsertControl({
  nodeId,
  placement,
  kinds,
  onInsert,
}) {
  const [open, setOpen] = useState(false)
  const placementLabel = placement === 'before' ? '之前' : '之后'

  return (
    <div
      className={automationClass(`workflow-node-insert ${placement}`)}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        className={automationClass('workflow-node-insert-trigger nodrag nopan')}
        data-testid={`automation-node-insert-${placement}-${nodeId}`}
        aria-label={`在当前节点${placementLabel}添加流程节点`}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <Plus size={16} />
      </button>
      {open ? (
        <div className={automationClass(`workflow-node-insert-menu nodrag nopan ${placement}`)}>
          {kinds.map(kind => {
            const { label, Icon } = INSERT_ITEM_DEFS[kind]
            return (
              <button
                key={kind}
                type="button"
                data-testid={`automation-node-insert-${placement}-${kind}-${nodeId}`}
                onClick={() => {
                  onInsert(placement, kind)
                  setOpen(false)
                }}
              >
                <Icon size={14} />
                {label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
})

const WorkflowNodeInsertControls = memo(function WorkflowNodeInsertControls({
  nodeId,
  allowBefore = true,
  readOnly = false,
  kinds = TOP_LEVEL_INSERT_KINDS,
  onInsert,
}) {
  if (readOnly) return null
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
  )
})

const BranchContinuationControl = memo(function BranchContinuationControl({
  branchId,
  readOnly = false,
  kinds,
  onInsertContinuation,
}) {
  const [open, setOpen] = useState(false)
  if (readOnly) return null
  return (
    <div
      className={automationClass('react-flow-branch-continuation')}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
    >
      <button
        type="button"
        className={automationClass('react-flow-branch-continuation-trigger nodrag nopan')}
        data-testid={`branch-continuation-${branchId}`}
        aria-label="添加完成后继续节点"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <Plus size={12} />
      </button>
      {open ? (
        <div className={automationClass('react-flow-branch-continuation-menu nodrag nopan')}>
          {kinds.map(candidate => {
            const { label, Icon } = INSERT_ITEM_DEFS[candidate]
            return (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  onInsertContinuation(branchId, candidate)
                  setOpen(false)
                }}
              >
                <Icon size={13} />
                {label}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
})

const TriggerCanvasNode = memo(function TriggerCanvasNode({ data, selected }) {
  const { t } = useTranslation()
  const TriggerIcon = data.triggerType === 'schedule' ? Clock3 : Webhook
  return (
    <article
      className={automationClass(`workflow-node-shell ${selected ? 'selected' : ''}`)}
      onMouseDownCapture={event => selectNodeFromMouse(event, data.onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(`flow-node trigger ${selected ? 'selected' : ''}`)}
        data-testid="automation-trigger-node"
        onClick={data.onSelect}
      >
        <span className={automationClass('node-icon trigger')}>
          <TriggerIcon size={17} />
        </span>
        <span className={automationClass('flow-node-copy')}>
          <small>
            {t(
              data.advancement === 'ai'
                ? 'todo.automation_ai_entry'
                : 'todo.automation_trigger_entry'
            )}
          </small>
          <strong>{data.title}</strong>
          <span>{data.meta}</span>
        </span>
        <ChevronRight size={14} />
      </button>
      {!data.readOnly && (
        <WorkflowNodeInsertControls
          readOnly={data.readOnly}
          nodeId="trigger"
          allowBefore={false}
          onInsert={data.onInsert}
        />
      )}
    </article>
  )
})
const SelectionSyncedTriggerCanvasNode = withCanvasNodeSelection(TriggerCanvasNode)

function executionSummary(environment, model) {
  const normalizedEnvironment = /^(Local Executor|本机执行器)(\s*·.*)?$/i.test(environment)
    ? '本机'
    : environment.replace(/\s*·\s*(在线|忙碌)$/, '')
  return [normalizedEnvironment, model].filter(Boolean).join(' · ') || '尚未配置执行环境'
}

const ExecutionCanvasNode = memo(function ExecutionCanvasNode({ data, selected }) {
  return (
    <article
      className={automationClass(`workflow-node-shell ${selected ? 'selected' : ''}`)}
      onMouseDownCapture={event => selectNodeFromMouse(event, data.onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(`flow-node step ${selected ? 'selected' : ''}`)}
        data-testid={`execution-node-${data.step.id}`}
        onClick={data.onSelect}
      >
        <span className={automationClass('node-icon step')}>
          <Box size={17} />
        </span>
        <span className={automationClass('flow-node-copy')}>
          <small>{data.step.executionMode === 'automatic' ? '自动执行' : '手动执行'}</small>
          <strong>{data.step.name || '未命名执行节点'}</strong>
          <span>
            {data.step.executionMode === 'automatic'
              ? executionSummary(data.step.environment, data.step.model)
              : '由成员手动完成'}
          </span>
        </span>
        <ChevronRight size={14} />
      </button>
      {!data.readOnly && (
        <WorkflowNodeInsertControls
          readOnly={data.readOnly}
          nodeId={data.step.id}
          onInsert={data.onInsert}
        />
      )}
    </article>
  )
})
const SelectionSyncedExecutionCanvasNode = withCanvasNodeSelection(ExecutionCanvasNode)

const BranchConditionRows = memo(function BranchConditionRows({ step }) {
  const { t } = useTranslation('common')
  const conditions = step.branchConditions ?? []
  return (
    <div className={automationClass('react-flow-branch-conditions')}>
      {conditions.length === 0 ? (
        <div className={automationClass('react-flow-branch-empty')}>
          还没有分支，可通过右侧加号添加
        </div>
      ) : (
        conditions.map((condition, index) => (
          <div
            className={automationClass('react-flow-branch-condition-row')}
            key={`${condition.eventType}-${index}`}
          >
            <em>分支 {index + 1}</em>
            <span>
              {eventTypeLabel(condition.eventType, t) || '未选择事件'}
              <i>{(condition.handlerNodeIds ?? []).length} 个节点</i>
            </span>
            <Handle
              type="source"
              id={`cond-${index}`}
              position={Position.Right}
              className={automationClass('react-flow-branch-handle')}
            />
          </div>
        ))
      )}
    </div>
  )
})

const BranchNodeHeader = memo(function BranchNodeHeader({ step, testId, onSelect }) {
  return (
    <button
      type="button"
      className={automationClass('react-flow-branch-header')}
      data-testid={testId}
      onClick={onSelect}
    >
      <span className={automationClass('node-icon branch', '!size-7 !rounded-md')}>
        <Webhook size={14} />
      </span>
      <span>
        <strong>{step.name || '分支'}</strong>
        <small>按事件路由 · {(step.branchConditions ?? []).length} 个条件</small>
      </span>
    </button>
  )
})

const BranchCanvasNode = memo(function BranchCanvasNode({ data, selected }) {
  const { step, onSelect, onAddBranchHandler, onAddBranchContinuation } = data
  return (
    <article
      className={automationClass(`workflow-node-shell ${selected ? 'selected' : ''}`)}
      onMouseDownCapture={event => selectNodeFromMouse(event, onSelect)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={automationClass('automation-hidden-handle')}
      />
      <div
        className={automationClass(`react-flow-branch-node ${selected ? 'selected' : ''}`)}
        data-testid={`branch-node-${step.id}`}
      >
        <BranchNodeHeader step={step} testId={`branch-node-main-${step.id}`} onSelect={onSelect} />
        <BranchConditionRows step={step} />
        <div className={automationClass('react-flow-branch-footer')}>
          <span>完成后继续</span>
          <BranchContinuationControl
            readOnly={data.readOnly}
            branchId={step.id}
            kinds={BRANCH_HANDLER_KINDS}
            onInsertContinuation={onAddBranchContinuation}
          />
          <Handle
            type="source"
            id="default"
            position={Position.Right}
            className={automationClass('react-flow-branch-handle')}
          />
        </div>
      </div>
      <WorkflowNodeInsertControls
        readOnly={data.readOnly}
        nodeId={step.id}
        allowBefore={false}
        kinds={BRANCH_HANDLER_KINDS}
        onInsert={(placement, kind) =>
          onAddBranchHandler(step.id, { kind, eventType: '', select: 'branch' })
        }
      />
    </article>
  )
})
const SelectionSyncedBranchCanvasNode = withCanvasNodeSelection(BranchCanvasNode)

const LoopBranchCanvasNode = memo(function LoopBranchCanvasNode({ data, selected }) {
  const { step, onSelect, onAddBranchHandler } = data
  return (
    <article
      className={automationClass(`react-flow-branch-node ${selected ? 'selected' : ''}`)}
      onMouseDownCapture={event => selectNodeFromMouse(event, onSelect)}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={automationClass('automation-hidden-handle')}
      />
      <BranchNodeHeader step={step} testId={`loop-body-node-${step.id}`} onSelect={onSelect} />
      <BranchConditionRows step={step} />
      <WorkflowNodeInsertControls
        readOnly={data.readOnly}
        nodeId={step.id}
        allowBefore={false}
        kinds={LOOP_BODY_INSERT_KINDS}
        onInsert={(placement, kind) =>
          onAddBranchHandler(step.id, { kind, eventType: '', select: 'branch' })
        }
      />
    </article>
  )
})
const SelectionSyncedLoopBranchCanvasNode = withCanvasNodeSelection(LoopBranchCanvasNode)

const LoopMarkerCanvasNode = memo(function LoopMarkerCanvasNode({ data, selected }) {
  const { step, onSelect, onInsert } = data
  const isStart = step.nodeType === 'loopStart'
  return (
    <article
      className={automationClass(`react-flow-loop-marker-node ${selected ? 'selected' : ''}`)}
      title={step.name || (isStart ? '循环开始' : '循环结束')}
      onMouseDownCapture={event => selectNodeFromMouse(event, onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass(
          `react-flow-loop-marker-main ${isStart ? 'start' : 'end'} ${selected ? 'selected' : ''}`
        )}
        data-testid={`loop-body-node-${step.id}`}
        aria-label={step.name || (isStart ? '循环开始' : '循环结束')}
        onClick={onSelect}
      >
        {isStart ? <CircleDot size={18} /> : <Flag size={16} />}
      </button>
      <WorkflowNodeInsertControls
        readOnly={data.readOnly}
        nodeId={step.id}
        allowBefore={false}
        kinds={LOOP_BODY_INSERT_KINDS}
        onInsert={onInsert}
      />
    </article>
  )
})
const SelectionSyncedLoopMarkerCanvasNode = withCanvasNodeSelection(LoopMarkerCanvasNode)

const LoopBodyCanvasNode = memo(function LoopBodyCanvasNode({ data, selected }) {
  const { step, onSelect, onInsert } = data
  const caption =
    step.executionMode === 'automatic' ? executionSummary(step.environment, step.model) : '手动执行'
  return (
    <article
      className={automationClass(`react-flow-loop-body-node ${selected ? 'selected' : ''}`)}
      onMouseDownCapture={event => selectNodeFromMouse(event, onSelect)}
    >
      <HorizontalHandles />
      <button
        type="button"
        className={automationClass('react-flow-loop-body-main')}
        data-testid={`loop-body-node-${step.id}`}
        onClick={onSelect}
      >
        <span className={automationClass('node-icon')}>
          <Box size={14} />
        </span>
        <span>
          <strong>{step.name || '未命名节点'}</strong>
          <small>{caption}</small>
        </span>
      </button>
      <WorkflowNodeInsertControls
        readOnly={data.readOnly}
        nodeId={step.id}
        allowBefore={false}
        kinds={LOOP_BODY_INSERT_KINDS}
        onInsert={onInsert}
      />
    </article>
  )
})
const SelectionSyncedLoopBodyCanvasNode = withCanvasNodeSelection(LoopBodyCanvasNode)

const LoopGroupCanvasNode = memo(function LoopGroupCanvasNode({ id, data, selected }) {
  const { step, onSelect, onInsert } = data
  const childSelected = useStore(
    useCallback(state => state.nodes.some(node => node.parentId === id && node.selected), [id])
  )
  const highlighted = selected || childSelected
  const loopConfig = step.loopConfig ?? {
    maxAttempts: 5,
    timeoutSeconds: null,
  }
  const attemptSummary =
    (loopConfig.maxAttempts ?? 5) === 0 ? '无限次' : `最多 ${loopConfig.maxAttempts ?? 5} 次`
  const timeoutSummary = loopConfig.timeoutSeconds ? ` · ${loopConfig.timeoutSeconds}s 超时` : ''
  return (
    <section
      className={automationClass(`react-flow-loop-group ${highlighted ? 'selected' : ''}`)}
      data-testid={`loop-node-${step.id}`}
      onMouseDownCapture={event => selectNodeFromMouse(event, onSelect)}
    >
      <HorizontalHandles />
      <WorkflowNodeInsertControls readOnly={data.readOnly} nodeId={step.id} onInsert={onInsert} />
      <div className={automationClass('react-flow-loop-body-area')} />
      <div className={automationClass('react-flow-loop-header')}>
        <button
          type="button"
          className={automationClass('react-flow-loop-header-main')}
          data-testid={`loop-node-main-${step.id}`}
          onClick={onSelect}
        >
          <span className={automationClass('node-icon coordinator')}>
            <Repeat size={15} />
          </span>
          <span>
            <small>循环</small>
            <strong>{step.name || '未命名循环'}</strong>
            <em>
              {attemptSummary}
              {timeoutSummary}
            </em>
          </span>
        </button>
      </div>
    </section>
  )
})
const SelectionSyncedLoopGroupCanvasNode = withCanvasNodeSelection(LoopGroupCanvasNode)

export const nodeTypes = {
  trigger: SelectionSyncedTriggerCanvasNode,
  execution: SelectionSyncedExecutionCanvasNode,
  branch: SelectionSyncedBranchCanvasNode,
  loopGroup: SelectionSyncedLoopGroupCanvasNode,
  loopBranch: SelectionSyncedLoopBranchCanvasNode,
  loopMarker: SelectionSyncedLoopMarkerCanvasNode,
  loopBody: SelectionSyncedLoopBodyCanvasNode,
}
