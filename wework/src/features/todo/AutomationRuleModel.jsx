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
        !node.name.trim() || (node.kind === 'dynamic' && hasUnnamedNode(node.subgraph?.nodes ?? []))
    )

  return hasUnnamedNode(rule.steps) ? '请填写所有执行节点名称' : ''
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
      source: 'issue',
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
