import { eventTypeLabel } from './eventTypeLabel'
import {
  BRANCH_HANDLER_ROW_GAP,
  OUTER_NODE_GAP,
  OUTER_NODE_HEIGHT,
  OUTER_NODE_WIDTH,
  stepCanvasSize,
} from './canvasGeometry'
export function createExecutionNode({
  id,
  name,
  prompt,
  kind = 'task',
  dependencies = [],
  dependencyContext = {},
  x = 0,
  y = 0,
  deliverables = [],
  executionMode = 'automatic',
  environment = '',
  executionEnvironment = 'local',
  executionDeviceId = null,
  runtimeProfileId = null,
  model = '',
  modelType = null,
  modelOptions = {},
  plugins = [],
  projectPlugins = [],
  workspacePolicy = executionMode === 'automatic' ? 'none' : 'composer',
  required = true,
  automationRuleId = null,
  executionConfig = null,
  executionConfigOverride = false,
  approvalPolicy = undefined,
  subgraph = null,
  nodeType = 'task',
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
  }
}

export function defaultExecutionConfiguration(executionCatalog) {
  const environment = executionCatalog.environments[0]
  const model = executionCatalog.models[0]
  return {
    environment: environment?.label ?? '',
    executionEnvironment: environment?.executionEnvironment ?? 'local',
    executionDeviceId: environment?.deviceId ?? null,
    model: model?.name ?? '',
    modelType: model?.type ?? null,
    modelOptions: model?.options ?? {},
  }
}

export function createCoordinator(executionCatalog, id = `step-${Date.now()}`) {
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    kind: 'task',
    name: 'AI',
    prompt:
      '根据工单目标和已有结果选择角色并交办具体工作；可以跳过、退回或交给人，满足工单要求后完成。',
    approvalPolicy: 'automatic',
    subgraph: null,
  })
}

export const frequencyLabels = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
}

export const weekdayLabels = {
  monday: '周一',
  tuesday: '周二',
  wednesday: '周三',
  thursday: '周四',
  friday: '周五',
  saturday: '周六',
  sunday: '周日',
}

export function triggerPresentation(trigger, t) {
  if (trigger.type === 'workflow')
    return {
      label: t('workbench.board_automation_dispatch_trigger'),
      detail: t('workbench.board_automation_dispatch_description'),
    }
  if (trigger.type === 'schedule') {
    const schedule = trigger.schedule
    const frequency =
      schedule.frequency === 'weekly'
        ? `每周${weekdayLabels[schedule.weekday]}`
        : frequencyLabels[schedule.frequency]
    return {
      label:
        schedule.frequency === 'hourly'
          ? t('workbench.board_automation_hourly_summary', {
              minute: Number(schedule.time.split(':')[1]),
            })
          : `${frequency} ${schedule.time}`,
      detail: `按计划执行 · ${schedule.timezone}`,
    }
  }

  if (trigger.source !== 'wework') {
    return {
      label: eventTypeLabel(trigger.event, t),
      detail: trigger.subscriptionId ? `事件订阅 ${trigger.subscriptionId}` : '选择事件订阅后运行',
    }
  }

  if (trigger.startMode === 'status') {
    return {
      label: 'Issue 开始处理时',
      detail: 'Issue 从未开始区域进入处理阶段或其后任意状态时启动',
    }
  }

  const tagSuffix = trigger.tags.length
    ? `，且包含标签「${trigger.tags.join('、')}」中的任意一个`
    : ''
  return {
    label: 'Issue 创建后自动启动',
    detail: `创建新的 Issue 后立即运行${tagSuffix}`,
  }
}

export function cloneRule(rule) {
  const cloneNode = step => ({
    ...step,
    dependencies: [...(step.dependencies ?? [])],
    dependencyContext: Object.fromEntries(
      Object.entries(step.dependencyContext ?? {}).map(([dependencyId, sources]) => [
        dependencyId,
        [...sources],
      ])
    ),
    deliverables: step.deliverables.map(deliverable => ({ ...deliverable })),
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
  })
  return {
    ...rule,
    trigger: {
      ...rule.trigger,
      tags: [...rule.trigger.tags],
      schedule: { ...rule.trigger.schedule },
    },
    steps: rule.steps.map(cloneNode),
  }
}

export function validateRule(rule) {
  if (!rule.name.trim()) return '请填写自动化名称'

  const hasUnnamedNode = nodes =>
    nodes.some(
      node =>
        !node.name.trim() ||
        ((node.kind === 'dynamic' || node.kind === 'loop') &&
          hasUnnamedNode(node.subgraph?.nodes ?? []))
    )
  if (hasUnnamedNode(rule.steps)) return '请填写所有执行节点名称'

  const hasInvalidBranchCondition = nodes =>
    nodes.some(
      node =>
        (node.branchConditions ?? []).some(condition => !(condition.eventType ?? '').trim()) ||
        hasInvalidBranchCondition(node.subgraph?.nodes ?? [])
    )
  if (hasInvalidBranchCondition(rule.steps)) return '请为每个分支选择事件类型'

  const hasDuplicateBranchCondition = nodes =>
    nodes.some(node => {
      const conditionKeys = new Set()
      const duplicated = (node.branchConditions ?? []).some(condition => {
        const key = `${condition.sourceType ?? 'github'}:${condition.eventType ?? ''}`
        if (conditionKeys.has(key)) return true
        conditionKeys.add(key)
        return false
      })
      return duplicated || hasDuplicateBranchCondition(node.subgraph?.nodes ?? [])
    })
  return hasDuplicateBranchCondition(rule.steps) ? '同一分支下的事件平台和事件类型不能重复' : ''
}

export function mergeSavedIdentity(rule, saved) {
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
  }
}

export function makeRule() {
  return {
    advancement: 'sequential',
    coordinator: null,
    id: `draft-${crypto.randomUUID()}`,
    persisted: false,
    origin: 'automation',
    version: 1,
    name: '未命名自动化',
    description: '',
    enabled: true,
    updatedAt: '尚未保存',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: 'event',
      source: 'wework',
      startMode: 'immediate',
      event: 'created',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [],
    legacyDefinition: null,
  }
}

export function makeRuleFromTemplate(template, executionCatalog) {
  const createdAt = Date.now()
  const rule = makeRule()
  const executionDefaults = defaultExecutionConfiguration(executionCatalog)
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
        deliverables: (step.deliverables ?? []).map((deliverable, deliverableIndex) => ({
          ...deliverable,
          id: `deliverable-${createdAt}-${stepIndex + 1}-${deliverableIndex + 1}`,
        })),
        plugins: [...(step.plugins ?? [])],
      })
    ),
  }
}

export function createLoopNode(id = `loop-${Date.now()}`) {
  const bodyId = `loop-start-${Date.now()}`
  return createExecutionNode({
    id,
    kind: 'loop',
    name: '循环',
    prompt: '',
    dependencies: [],
    dependencyContext: {},
    executionMode: 'manual',
    workspacePolicy: 'none',
    nodeType: 'loop',
    bodyNodeIds: [bodyId],
    loopConfig: {
      maxAttempts: 5,
      timeoutSeconds: null,
    },
    subgraph: {
      nodes: [
        createExecutionNode({
          id: bodyId,
          name: '循环开始',
          kind: 'task',
          nodeType: 'loopStart',
          executionMode: 'manual',
          workspacePolicy: 'none',
          dependencies: [],
          dependencyContext: {},
          x: 0,
          y: 0,
        }),
      ],
    },
  })
}

export function createLoopBodyNode(executionCatalog, loopId, kind) {
  const id = `loop-body-${Date.now()}`
  if (kind === 'branch') {
    return createExecutionNode({
      id,
      name: '分支',
      kind: 'task',
      nodeType: 'branch',
      loopId,
      executionMode: 'manual',
      workspacePolicy: 'none',
      dependencies: [],
      dependencyContext: {},
      x: 240,
      y: 0,
      branchConditions: [],
      eventWait: {
        collectionMode: 'poll',
        subscriptionId: null,
        pollIntervalSeconds: 300,
      },
    })
  }
  if (kind === 'loopEnd') {
    return createExecutionNode({
      id,
      name: '循环结束',
      kind: 'task',
      nodeType: 'loopEnd',
      loopId,
      executionMode: 'manual',
      workspacePolicy: 'none',
      dependencies: [],
      dependencyContext: {},
      x: 240,
      y: 90,
    })
  }
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    name: '',
    prompt: '',
    kind: 'task',
    nodeType: 'task',
    loopId,
    dependencies: [],
    dependencyContext: {},
    x: 240,
    y: 90,
  })
}

export function createBranchNode(id = `branch-${Date.now()}`) {
  return createExecutionNode({
    id,
    kind: 'branch',
    name: '分支',
    prompt: '',
    dependencies: [],
    dependencyContext: {},
    executionMode: 'manual',
    workspacePolicy: 'none',
    nodeType: 'branch',
    branchConditions: [],
    eventWait: {
      collectionMode: 'poll',
      subscriptionId: null,
      pollIntervalSeconds: 300,
    },
  })
}

export function createBranchHandlerNode(executionCatalog, kind, id) {
  if (kind === 'loop') return createLoopNode(id)
  if (kind === 'branch') return createBranchNode(id)
  return createExecutionNode({
    ...defaultExecutionConfiguration(executionCatalog),
    id,
    name: '',
    prompt: '',
  })
}

export function createLoopBranchHandlerNode(executionCatalog, loopId, kind) {
  if (kind === 'branch') return createLoopBodyNode(executionCatalog, loopId, 'branch')
  if (kind === 'loopEnd') return createLoopBodyNode(executionCatalog, loopId, 'loopEnd')
  return createLoopBodyNode(executionCatalog, loopId, 'task')
}

export function insertStepAfter(
  container,
  anchorId,
  node,
  { gap, condition = null, alignY = null, stack = false, nodeSize = stepCanvasSize }
) {
  const branchIndex = container.findIndex(candidate => candidate.id === anchorId)
  if (branchIndex < 0) return null
  const anchor = container[branchIndex]
  const nodeId = node.id
  const insertionX = (anchor.x ?? 0) + gap
  // Condition handlers already added to this branch stay in the handler column
  // so new handlers stack downward instead of pushing the column to the right.
  const handlerIds = new Set(
    (anchor.branchConditions ?? []).flatMap(condition => condition.handlerNodeIds ?? [])
  )
  let insertionY
  if (alignY != null) {
    insertionY = alignY
  } else if (stack) {
    const stackedHandlers = container.filter(candidate => handlerIds.has(candidate.id))
    if (stackedHandlers.length > 0) {
      const bottomY = Math.max(
        ...stackedHandlers.map(candidate => (candidate.y ?? 0) + nodeSize(candidate).height)
      )
      insertionY = bottomY + BRANCH_HANDLER_ROW_GAP
    } else {
      insertionY = anchor.y ?? 0
    }
  } else {
    insertionY = anchor.y ?? 0
  }
  const inserted = {
    ...node,
    x: insertionX,
    y: insertionY,
    dependencies: [anchorId],
    dependencyContext: { [anchorId]: ['final_result', 'deliveries'] },
  }
  const next = []
  container.forEach((node, index) => {
    let value = node
    if (!stack || !handlerIds.has(node.id)) {
      if (node.x >= insertionX) value = { ...value, x: value.x + gap }
    }
    if (node.id === anchorId && condition) {
      value = {
        ...value,
        branchConditions: [
          ...(value.branchConditions ?? []),
          { ...condition, handlerNodeIds: [nodeId] },
        ],
      }
    }
    next.push(value)
    if (index === branchIndex) next.push(inserted)
  })
  return { container: next, nodeId }
}

export function findBranchOwner(steps, branchId) {
  const topStep = steps.find(step => step.id === branchId && step.kind === 'branch')
  if (topStep) return { type: 'top', step: topStep }
  const loopStep = steps.find(
    step =>
      step.kind === 'loop' &&
      (step.subgraph?.nodes ?? []).some(node => node.id === branchId && node.nodeType === 'branch')
  )
  if (loopStep) return { type: 'loop', step: loopStep }
  return null
}
