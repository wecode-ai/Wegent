import type {
  ProjectAutomationInput,
  ProjectAutomationRule,
  ProjectAutomationRun,
} from '@/api/projectAutomations'
import type {
  CloudProject,
  ProjectWorkflowDefinition,
  WorkflowContextSource,
  WorkflowExecutionConfig,
  WorkflowNodeDefinition,
} from '@/api/deliveries'

const FLOW_KEY = 'wework_flow'

export interface AutomationUiDeliverable {
  id: string
  name: string
  description: string
  valueType: 'text' | 'file' | 'code_snapshot' | 'git_branch' | 'pull_request' | 'url'
  fileConstraints?: {
    accepted_types: string[]
    min_files: number
    max_files: number
  } | null
}

export interface AutomationUiStep {
  id: string
  name: string
  prompt: string
  kind: 'task' | 'dynamic'
  dependencies: string[]
  dependencyContext: Record<string, WorkflowContextSource[]>
  x: number
  y: number
  deliverables: AutomationUiDeliverable[]
  executionMode: 'manual' | 'automatic'
  environment: string
  executionEnvironment: 'local' | 'cloud'
  executionDeviceId: string | null
  runtimeProfileId: string | null
  model: string
  modelType: 'public' | 'user' | 'group' | 'runtime' | null
  modelOptions: Record<string, string>
  plugins: string[]
  projectPlugins: Array<Record<string, unknown>>
  workspacePolicy: 'none' | 'composer' | 'inherit'
  required: boolean
  automationRuleId: string | null
  executionConfig: WorkflowExecutionConfig | null
  executionConfigOverride: boolean
  approvalPolicy?: 'required' | 'automatic'
  subgraph: AutomationUiGraph | null
}

export interface AutomationUiGraph {
  nodes: AutomationUiStep[]
}

export interface AutomationUiTrigger {
  type: 'event' | 'schedule'
  source: 'issue'
  startMode: 'immediate' | 'status'
  event: 'created' | 'status_changed'
  tags: string[]
  schedule: {
    frequency: 'hourly' | 'daily' | 'weekdays' | 'weekly'
    weekday: string
    time: string
    timezone: string
  }
}

export interface AutomationUiRule {
  id: string
  persisted: boolean
  origin: 'automation' | 'legacy_workflow'
  version: number
  name: string
  description: string
  enabled: boolean
  updatedAt: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunStatus: ProjectAutomationRun['status'] | null
  trigger: AutomationUiTrigger
  steps: AutomationUiStep[]
  legacyDefinition: ProjectWorkflowDefinition | null
}

export interface AutomationUiRun {
  id: string
  ruleId: string
  ruleName: string
  issue: string
  status: ProjectAutomationRun['status']
  triggeredAt: string
  startedAt: string
  duration: string
}

export interface AutomationExecutionEnvironmentOption {
  deviceId: string
  label: string
  executionEnvironment: 'local' | 'cloud'
}

export interface AutomationModelOption {
  name: string
  label: string
  type: AutomationUiStep['modelType']
  options: Record<string, string>
}

export interface AutomationPluginOption {
  id: string
  label: string
  reference: Record<string, unknown>
}

export interface AutomationExecutionCatalog {
  environments: AutomationExecutionEnvironmentOption[]
  models: AutomationModelOption[]
  plugins: AutomationPluginOption[]
}

interface StoredAutomationFlowV1 {
  version: 1
  description: string
  steps: unknown[]
}

interface StoredAutomationFlowV2 {
  version: 2
  description: string
  graph: {
    nodes: unknown[]
  }
}

interface NormalizedAutomationFlowV2 {
  version: 2
  description: string
  graph: AutomationUiGraph
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function formatAutomationTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function normalizeDeliverables(value: unknown): AutomationUiDeliverable[] {
  return recordArray(value).map((item, index) => ({
    id: typeof item.id === 'string' ? item.id : `deliverable-${index + 1}`,
    name: typeof item.name === 'string' ? item.name : '未命名交付物',
    description: typeof item.description === 'string' ? item.description : '',
    valueType: deliverableValueType(
      typeof item.valueType === 'string'
        ? item.valueType
        : typeof item.type === 'string'
          ? item.type
          : 'text'
    ),
    fileConstraints: isRecord(item.fileConstraints)
      ? {
          accepted_types: stringArray(item.fileConstraints.accepted_types),
          min_files:
            typeof item.fileConstraints.min_files === 'number' ? item.fileConstraints.min_files : 1,
          max_files:
            typeof item.fileConstraints.max_files === 'number' ? item.fileConstraints.max_files : 1,
        }
      : null,
  }))
}

function normalizeStoredStep(
  value: unknown,
  index: number,
  inherited?: Partial<AutomationUiStep>
): AutomationUiStep {
  const item = isRecord(value) ? value : {}
  const id = typeof item.id === 'string' ? item.id : `step-${index + 1}`
  const kind = item.kind === 'dynamic' ? 'dynamic' : 'task'
  const executionMode = item.executionMode === 'manual' ? 'manual' : 'automatic'
  const executionEnvironment = item.executionEnvironment === 'cloud' ? 'cloud' : 'local'
  const legacyStages = recordArray(item.dagStages)
  const storedSubgraph = isRecord(item.subgraph) ? item.subgraph : null
  const subgraphNodes = Array.isArray(storedSubgraph?.nodes)
    ? storedSubgraph.nodes
    : legacyStages.map(stage => ({
        ...stage,
        prompt:
          typeof stage.instruction === 'string'
            ? stage.instruction
            : typeof stage.prompt === 'string'
              ? stage.prompt
              : '',
        kind: 'task',
        executionMode,
        environment: item.environment,
        executionEnvironment,
        executionDeviceId: item.executionDeviceId,
        runtimeProfileId: item.runtimeProfileId,
        model: item.model,
        modelType: item.modelType,
        modelOptions: item.modelOptions,
        plugins: item.plugins,
        projectPlugins: item.projectPlugins,
        workspacePolicy: item.workspacePolicy,
        required: true,
      }))
  const step: AutomationUiStep = {
    id,
    name: typeof item.name === 'string' ? item.name : inherited?.name || '未命名执行节点',
    prompt: typeof item.prompt === 'string' ? item.prompt : inherited?.prompt || '',
    kind,
    dependencies: stringArray(item.dependencies),
    dependencyContext: isRecord(item.dependencyContext)
      ? Object.fromEntries(
          Object.entries(item.dependencyContext).map(([dependencyId, sources]) => [
            dependencyId,
            stringArray(sources).filter(
              (source): source is WorkflowContextSource =>
                source === 'final_result' || source === 'deliveries' || source === 'activity'
            ),
          ])
        )
      : {},
    x: typeof item.x === 'number' ? item.x : index * 420 + 440,
    y: typeof item.y === 'number' ? item.y : 226,
    deliverables: normalizeDeliverables(item.deliverables),
    executionMode,
    environment:
      typeof item.environment === 'string' ? item.environment : inherited?.environment || '',
    executionEnvironment,
    executionDeviceId: typeof item.executionDeviceId === 'string' ? item.executionDeviceId : null,
    runtimeProfileId: typeof item.runtimeProfileId === 'string' ? item.runtimeProfileId : null,
    model: typeof item.model === 'string' ? item.model : inherited?.model || '',
    modelType:
      item.modelType === 'public' ||
      item.modelType === 'user' ||
      item.modelType === 'group' ||
      item.modelType === 'runtime'
        ? item.modelType
        : null,
    modelOptions: isRecord(item.modelOptions)
      ? Object.fromEntries(
          Object.entries(item.modelOptions).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        )
      : {},
    plugins: stringArray(item.plugins),
    projectPlugins: recordArray(item.projectPlugins),
    workspacePolicy:
      item.workspacePolicy === 'none' || item.workspacePolicy === 'inherit'
        ? item.workspacePolicy
        : 'composer',
    required: item.required !== false,
    automationRuleId: typeof item.automationRuleId === 'string' ? item.automationRuleId : null,
    executionConfig: isRecord(item.executionConfig)
      ? (item.executionConfig as unknown as WorkflowExecutionConfig)
      : null,
    executionConfigOverride: item.executionConfigOverride === true,
    approvalPolicy: item.approvalPolicy === 'automatic' ? 'automatic' : 'required',
    subgraph: null,
  }
  step.subgraph =
    kind === 'dynamic'
      ? {
          nodes: subgraphNodes.map((node, childIndex) => {
            const stage = normalizeStoredStep(node, childIndex)
            return {
              ...stage,
              environment: '',
              executionEnvironment: 'local',
              executionDeviceId: null,
              runtimeProfileId: null,
              model: '',
              modelType: null,
              modelOptions: {},
              plugins: [],
              projectPlugins: [],
              workspacePolicy: 'none',
              executionConfig: null,
              executionConfigOverride: false,
              approvalPolicy: undefined,
              subgraph: null,
            }
          }),
        }
      : null
  return step
}

function storedFlow(rule: ProjectAutomationRule): NormalizedAutomationFlowV2 | null {
  const candidate = rule.eventConfig[FLOW_KEY]
  if (!isRecord(candidate)) {
    return null
  }
  if (
    candidate.version === 2 &&
    isRecord(candidate.graph) &&
    Array.isArray(candidate.graph.nodes)
  ) {
    return {
      version: 2,
      description: typeof candidate.description === 'string' ? candidate.description : rule.prompt,
      graph: {
        nodes: candidate.graph.nodes.map((step, index) => normalizeStoredStep(step, index)),
      },
    }
  }
  if (candidate.version !== 1 || !Array.isArray(candidate.steps)) {
    return null
  }
  const legacy = candidate as unknown as StoredAutomationFlowV1
  return {
    version: 2,
    description: typeof legacy.description === 'string' ? legacy.description : rule.prompt,
    graph: {
      nodes: legacy.steps.map((step, index) => normalizeStoredStep(step, index)),
    },
  }
}

function parseCron(expression: string | null) {
  const parts = (expression ?? '0 3 * * *').trim().split(/\s+/)
  const minute = Number(parts[0] ?? 0)
  const hour = Number(parts[1] ?? 3)
  const dayOfWeek = parts[4] ?? '*'
  const time = `${String(Number.isFinite(hour) ? hour : 3).padStart(2, '0')}:${String(
    Number.isFinite(minute) ? minute : 0
  ).padStart(2, '0')}`
  if (parts[1] === '*' && parts.slice(2).every(part => part === '*')) {
    return {
      frequency: 'hourly' as const,
      weekday: 'monday',
      time: `00:${String(minute).padStart(2, '0')}`,
    }
  }
  if (dayOfWeek === '1-5') {
    return { frequency: 'weekdays' as const, weekday: 'monday', time }
  }
  if (/^[0-6]$/.test(dayOfWeek)) {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    return { frequency: 'weekly' as const, weekday: weekdays[Number(dayOfWeek)], time }
  }
  return { frequency: 'daily' as const, weekday: 'monday', time }
}

function buildCron(trigger: AutomationUiTrigger): string {
  const [hourText, minuteText] = trigger.schedule.time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)
  if (trigger.schedule.frequency === 'hourly') return `${minute} * * * *`
  const prefix = `${Number.isFinite(minute) ? minute : 0} ${Number.isFinite(hour) ? hour : 3}`
  if (trigger.schedule.frequency === 'weekdays') return `${prefix} * * 1-5`
  if (trigger.schedule.frequency === 'weekly') {
    const weekday = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    }[trigger.schedule.weekday]
    return `${prefix} * * ${weekday ?? 1}`
  }
  return `${prefix} * * *`
}

function fallbackStep(rule: ProjectAutomationRule): AutomationUiStep {
  return {
    id: `step-${rule.id}`,
    name: rule.agentName || '执行任务',
    prompt: rule.prompt,
    kind: rule.assignmentMode === 'ai_managed' ? 'dynamic' : 'task',
    dependencies: [],
    dependencyContext: {},
    x: 440,
    y: 226,
    deliverables: [],
    executionMode: 'automatic',
    environment:
      rule.executionEnvironment === 'cloud'
        ? '云端'
        : rule.executionEnvironment === 'managed'
          ? 'Wegent 托管'
          : '本机',
    executionEnvironment: rule.executionEnvironment === 'cloud' ? 'cloud' : 'local',
    executionDeviceId: rule.executionDeviceId,
    runtimeProfileId: rule.runtimeProfileId ?? null,
    model: rule.model ?? '',
    modelType: null,
    modelOptions: {},
    plugins: ['Wework 项目空间'],
    projectPlugins: [],
    workspacePolicy: 'composer',
    required: true,
    automationRuleId: rule.triggerType === 'workflow' ? rule.id : null,
    executionConfig: null,
    executionConfigOverride: false,
    subgraph: rule.assignmentMode === 'ai_managed' ? { nodes: [] } : null,
  }
}

export function automationRuleFromBackend(rule: ProjectAutomationRule): AutomationUiRule {
  const flow = storedFlow(rule)
  const schedule = parseCron(rule.cronExpression)
  const startMode = rule.eventType === 'task.status_changed' ? 'status' : 'immediate'
  return {
    id: rule.id,
    persisted: true,
    origin: 'automation',
    version: rule.version,
    name: rule.name,
    description: flow?.description ?? rule.prompt,
    enabled: rule.enabled,
    updatedAt: formatAutomationTimestamp(rule.updatedAt),
    nextRunAt: rule.nextRunAt,
    lastRunAt: rule.lastRunAt,
    lastRunStatus: rule.lastRunStatus,
    trigger: {
      type: rule.triggerType === 'schedule' ? 'schedule' : 'event',
      source: 'issue',
      startMode,
      event: startMode === 'status' ? 'status_changed' : 'created',
      tags: Array.isArray(rule.eventConfig.tags)
        ? rule.eventConfig.tags.filter((value): value is string => typeof value === 'string')
        : [],
      schedule: {
        ...schedule,
        timezone: rule.timezone,
      },
    },
    steps: flow?.graph.nodes.length ? flow.graph.nodes : [fallbackStep(rule)],
    legacyDefinition: null,
  }
}

function mergedExecutionConfig(
  base: WorkflowExecutionConfig | null | undefined,
  node: WorkflowNodeDefinition
): WorkflowExecutionConfig | null {
  const local = node.execution_config
  if (node.execution_config_override) {
    if (!local) return null
    if (!base) return local
    return {
      ...base,
      ...local,
      model_options: local.model ? local.model_options : base.model_options,
      project_plugins: local.project_plugins ?? base.project_plugins,
      additional_skills: local.additional_skills ?? base.additional_skills,
      attachments: local.attachments ?? base.attachments,
      attachment_ids: local.attachment_ids ?? base.attachment_ids,
      additional_context: local.additional_context ?? base.additional_context,
    }
  }
  return base ?? local ?? null
}

function pluginLabel(plugin: Record<string, unknown>, index: number): string {
  const value = plugin.displayName ?? plugin.display_name ?? plugin.pluginName ?? plugin.plugin_name
  return typeof value === 'string' && value.trim() ? value : `插件 ${index + 1}`
}

function workflowNodeDepth(
  node: WorkflowNodeDefinition,
  nodes: Map<string, WorkflowNodeDefinition>,
  memo: Map<string, number>
): number {
  const cached = memo.get(node.id)
  if (cached !== undefined) return cached
  const depth = node.depends_on.length
    ? Math.max(
        ...node.depends_on.map(dependencyId => {
          const dependency = nodes.get(dependencyId)
          return dependency ? workflowNodeDepth(dependency, nodes, memo) + 1 : 0
        })
      )
    : 0
  memo.set(node.id, depth)
  return depth
}

function workflowNodesFromLegacy(
  definition: ProjectWorkflowDefinition,
  backendRules: ProjectAutomationRule[]
): AutomationUiStep[] {
  const nodesById = new Map(definition.nodes.map(node => [node.id, node]))
  const depthMemo = new Map<string, number>()
  const rowsByDepth = new Map<number, number>()
  return definition.nodes.map(node => {
    const referencedRule = node.automation_rule_id
      ? backendRules.find(rule => rule.id === node.automation_rule_id)
      : null
    const config = mergedExecutionConfig(definition.execution_config, node)
    const depth = workflowNodeDepth(node, nodesById, depthMemo)
    const row = rowsByDepth.get(depth) ?? 0
    rowsByDepth.set(depth, row + 1)
    const projectPlugins = recordArray(config?.project_plugins)
    return {
      id: node.id,
      name: node.name,
      prompt: node.prompt || referencedRule?.prompt || '',
      kind: 'task',
      dependencies: [...node.depends_on],
      dependencyContext: { ...(node.dependency_context ?? {}) },
      x: 440 + depth * 420,
      y: 150 + row * 150,
      deliverables: (node.required_deliverables ?? []).map(requirement => ({
        id: requirement.id,
        name: requirement.name,
        description: requirement.description,
        valueType: requirement.value_type,
        fileConstraints: requirement.file_constraints
          ? {
              accepted_types: [...requirement.file_constraints.accepted_types],
              min_files: requirement.file_constraints.min_files,
              max_files: requirement.file_constraints.max_files,
            }
          : null,
      })),
      executionMode: node.execution_mode === 'robot' ? 'automatic' : 'manual',
      environment: config?.execution_device_id
        ? `执行设备 ${config.execution_device_id}`
        : node.execution_mode === 'robot'
          ? '尚未配置执行环境'
          : '成员手动执行',
      executionEnvironment: 'local',
      executionDeviceId: config?.execution_device_id ?? referencedRule?.executionDeviceId ?? null,
      runtimeProfileId: config?.runtime_profile_id ?? referencedRule?.runtimeProfileId ?? null,
      model: config?.model ?? referencedRule?.model ?? '',
      modelType: config?.model_type ?? null,
      modelOptions: { ...(config?.model_options ?? {}) },
      plugins: projectPlugins.map(pluginLabel),
      projectPlugins,
      workspacePolicy: node.workspace_policy,
      required: node.required,
      automationRuleId: node.automation_rule_id ?? null,
      executionConfig: config,
      executionConfigOverride: node.execution_config_override ?? false,
      subgraph: null,
    }
  })
}

export function automationRuleFromLegacyWorkflow(
  project: CloudProject,
  backendRules: ProjectAutomationRule[]
): AutomationUiRule | null {
  const definition = project.workflow_definition
  const stageMode = definition?.stage_mode ?? (definition?.nodes.length ? 'dag' : 'none')
  const advancementPolicy = definition?.advancement_policy ?? 'manual'
  if (
    !definition ||
    (stageMode === 'none' && advancementPolicy === 'manual' && !definition.nodes.length)
  ) {
    return null
  }
  const workflowNodes = workflowNodesFromLegacy(definition, backendRules)
  const managerRule = definition.ai_automation_rule_id
    ? backendRules.find(rule => rule.id === definition.ai_automation_rule_id)
    : null
  const steps =
    advancementPolicy === 'ai'
      ? [
          {
            ...(managerRule
              ? fallbackStep(managerRule)
              : {
                  id: `legacy-manager-${project.id}`,
                  name: 'AI 动态分配',
                  prompt: definition.coordinator_prompt || '根据 Issue 动态拆解并分配任务',
                  kind: 'dynamic' as const,
                  dependencies: [],
                  dependencyContext: {},
                  x: 440,
                  y: 226,
                  deliverables: [],
                  executionMode: 'automatic' as const,
                  environment: '尚未配置执行环境',
                  executionEnvironment: 'local' as const,
                  executionDeviceId: null,
                  runtimeProfileId: null,
                  model: '',
                  modelType: null,
                  modelOptions: {},
                  plugins: [],
                  projectPlugins: [],
                  workspacePolicy: 'composer' as const,
                  required: true,
                  automationRuleId: null,
                  executionConfig: definition.execution_config ?? null,
                  executionConfigOverride: false,
                  approvalPolicy: definition.approval_policy,
                  subgraph: { nodes: [] },
                }),
            id: 'ai-dynamic-allocation',
            name: 'AI 动态分配',
            prompt: definition.coordinator_prompt || '根据 Issue 动态拆解并分配任务',
            x: 440,
            y: 226,
            automationRuleId: managerRule?.id ?? null,
            approvalPolicy: definition.approval_policy,
            subgraph: { nodes: workflowNodes },
          },
        ]
      : workflowNodes
  return {
    id: `legacy-workflow-${project.id}`,
    persisted: false,
    origin: 'legacy_workflow',
    version: project.version,
    name: `${project.name} Issue 编排`,
    description:
      definition.coordinator_prompt ||
      (advancementPolicy === 'ai'
        ? 'AI 根据 Issue 动态拆解、分配并推进任务'
        : 'Issue 进入处理状态后按照预设 DAG 推进'),
    enabled: stageMode === 'dag' || advancementPolicy === 'ai',
    updatedAt: formatAutomationTimestamp(project.updated_at),
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'status',
      event: 'status_changed',
      tags: [],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps,
    legacyDefinition: definition,
  }
}

function deliverableValueType(value: string) {
  if (
    value === 'text' ||
    value === 'file' ||
    value === 'code_snapshot' ||
    value === 'git_branch' ||
    value === 'pull_request' ||
    value === 'url'
  ) {
    return value
  }
  return 'text' as const
}

function executionConfigFromUiNode(node: AutomationUiStep): WorkflowExecutionConfig | null {
  if (node.executionMode === 'manual') return node.executionConfig
  const preserved = node.executionConfig ?? {
    agent_id: null,
    runtime_profile_id: null,
    execution_device_id: null,
    model: null,
    model_type: null,
    model_options: {},
    workspace_binding: null,
  }
  return {
    ...preserved,
    runtime_profile_id: node.runtimeProfileId,
    execution_device_id: node.executionDeviceId,
    model: node.model || null,
    model_type: node.modelType,
    model_options: { ...node.modelOptions },
    workspace_binding:
      node.workspacePolicy === 'composer'
        ? (preserved.workspace_binding ?? {
            type: 'standalone',
          })
        : {
            type: 'standalone',
          },
    project_plugins: node.projectPlugins.flatMap(plugin => {
      const id = typeof plugin.id === 'string' ? plugin.id : ''
      const pluginName = typeof plugin.pluginName === 'string' ? plugin.pluginName : ''
      const marketplaceId = typeof plugin.marketplaceId === 'string' ? plugin.marketplaceId : ''
      const displayName = typeof plugin.displayName === 'string' ? plugin.displayName : ''
      return id && pluginName && marketplaceId && displayName
        ? [{ id, pluginName, marketplaceId, displayName }]
        : []
    }),
  }
}

function workflowNodeFromUi(
  node: AutomationUiStep,
  includeExecutionConfig = true
): WorkflowNodeDefinition {
  return {
    id: node.id,
    name: node.name,
    prompt: node.prompt,
    execution_mode: node.executionMode === 'automatic' ? 'robot' : 'human',
    depends_on: [...node.dependencies],
    dependency_context: Object.fromEntries(
      node.dependencies.map(dependencyId => [
        dependencyId,
        node.dependencyContext[dependencyId] ?? ['final_result', 'deliveries'],
      ])
    ),
    required: node.required,
    required_deliverables: node.deliverables.map(deliverable => ({
      id: deliverable.id,
      name: deliverable.name,
      description: deliverable.description,
      value_type: deliverable.valueType,
      file_constraints:
        deliverable.valueType === 'file'
          ? (deliverable.fileConstraints ?? {
              accepted_types: [],
              min_files: 1,
              max_files: 1,
            })
          : null,
    })),
    workspace_policy: includeExecutionConfig ? node.workspacePolicy : 'none',
    automation_rule_id: node.automationRuleId,
    execution_config: includeExecutionConfig ? executionConfigFromUiNode(node) : null,
    execution_config_override: includeExecutionConfig && node.executionConfigOverride,
  }
}

export function legacyWorkflowFromAutomationRule(
  rule: AutomationUiRule
): ProjectWorkflowDefinition {
  const dynamicNode =
    rule.steps.length === 1 && rule.steps[0]?.kind === 'dynamic' ? rule.steps[0] : null
  const previous = rule.legacyDefinition
  if (dynamicNode) {
    return {
      version: Math.max(1, previous?.version ?? 1),
      stage_mode: dynamicNode.subgraph?.nodes.length ? 'dag' : 'none',
      advancement_policy: 'ai',
      coordinator_prompt: dynamicNode.prompt,
      approval_policy: dynamicNode.approvalPolicy ?? previous?.approval_policy ?? 'required',
      ai_automation_rule_id: dynamicNode.automationRuleId,
      execution_config: executionConfigFromUiNode(dynamicNode),
      nodes: (dynamicNode.subgraph?.nodes ?? []).map(node => workflowNodeFromUi(node, false)),
    }
  }
  return {
    version: Math.max(1, previous?.version ?? 1),
    stage_mode: rule.steps.length ? 'dag' : 'none',
    advancement_policy: 'manual',
    coordinator_prompt: previous?.coordinator_prompt ?? '',
    approval_policy: previous?.approval_policy ?? 'required',
    ai_automation_rule_id: null,
    execution_config: previous?.execution_config ?? null,
    nodes: rule.steps.map(node => workflowNodeFromUi(node)),
  }
}

function storedStageConstraint(node: AutomationUiStep): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    prompt: node.prompt,
    kind: 'task',
    dependencies: [...(node.dependencies ?? [])],
    dependencyContext: Object.fromEntries(
      Object.entries(node.dependencyContext ?? {}).map(([dependencyId, sources]) => [
        dependencyId,
        [...sources],
      ])
    ),
    x: node.x,
    y: node.y,
    deliverables: (node.deliverables ?? []).map(deliverable => ({ ...deliverable })),
    executionMode: node.executionMode,
    required: node.required,
    automationRuleId: node.automationRuleId,
  }
}

function storedStepFromUi(node: AutomationUiStep): Record<string, unknown> {
  return {
    ...node,
    dependencies: [...(node.dependencies ?? [])],
    dependencyContext: Object.fromEntries(
      Object.entries(node.dependencyContext ?? {}).map(([dependencyId, sources]) => [
        dependencyId,
        [...sources],
      ])
    ),
    deliverables: (node.deliverables ?? []).map(deliverable => ({ ...deliverable })),
    plugins: [...(node.plugins ?? [])],
    projectPlugins: (node.projectPlugins ?? []).map(plugin => ({ ...plugin })),
    modelOptions: { ...(node.modelOptions ?? {}) },
    subgraph:
      node.kind === 'dynamic'
        ? {
            nodes: (node.subgraph?.nodes ?? []).map(storedStageConstraint),
          }
        : null,
  }
}

function flowPrompt(rule: AutomationUiRule): string {
  const describeNodes = (nodes: AutomationUiStep[], depth = 0): string[] =>
    nodes.map((step, index) => {
      const deliverables = step.deliverables.length
        ? `\n交付物：${step.deliverables.map(item => item.name).join('、')}`
        : ''
      const dependencies = (step.dependencies ?? []).length
        ? `\n前置节点：${step.dependencies.join('、')}`
        : ''
      const subgraph =
        step.kind === 'dynamic' && step.subgraph?.nodes.length
          ? `\n子图：\n${describeNodes(step.subgraph.nodes, depth + 1).join('\n')}`
          : ''
      return `${'  '.repeat(depth)}${index + 1}. ${step.name}\n${'  '.repeat(depth)}${step.prompt}${deliverables}${dependencies}${subgraph}`
    })
  const steps = describeNodes(rule.steps)
  const description = rule.description.trim()
  return [
    ...(description ? [`自动化目标：${description}`] : []),
    '按照以下流程完成任务：',
    ...steps,
  ].join('\n\n')
}

export function automationInputFromUi(
  rule: AutomationUiRule,
  currentUserId: string | number
): ProjectAutomationInput {
  const runtimeUserId = Number(currentUserId)
  if (!Number.isInteger(runtimeUserId) || runtimeUserId <= 0) {
    throw new Error('当前用户缺少可用的 Runtime 身份，无法保存自动化')
  }
  const eventTrigger = rule.trigger.type === 'event'
  const isAiDynamicWorkflow = rule.steps.length === 1 && rule.steps[0]?.kind === 'dynamic'
  const description = rule.description.trim()
  return {
    name: rule.name.trim(),
    prompt: flowPrompt(rule),
    triggerType: eventTrigger ? 'event' : 'schedule',
    eventType: eventTrigger
      ? rule.trigger.startMode === 'status'
        ? 'task.status_changed'
        : 'task.created'
      : null,
    eventConfig: {
      tags: rule.trigger.tags,
      ...(rule.trigger.startMode === 'status' ? { transition: 'entered_processing' } : {}),
      runtime_workflow_definition: legacyWorkflowFromAutomationRule(rule),
      [FLOW_KEY]: {
        version: 2,
        description,
        graph: {
          nodes: rule.steps.map(storedStepFromUi),
        },
      } satisfies StoredAutomationFlowV2,
    },
    cronExpression: eventTrigger ? null : buildCron(rule.trigger),
    timezone: rule.trigger.schedule.timezone,
    enabled: rule.enabled,
    assignmentMode: isAiDynamicWorkflow ? 'ai_managed' : 'manual',
    managerType: isAiDynamicWorkflow ? 'custom' : null,
    agentId: null,
    wegentTeamId: null,
    model: null,
    executionEnvironment: null,
    executionDeviceId: null,
    roleSource: 'generic',
    runtimeSource: 'runtime_user',
    runtimeProfileId: null,
    runtimeUserId,
  }
}

function runDuration(run: ProjectAutomationRun): string {
  if (!run.completedAt) return run.status === 'running' ? '进行中' : '—'
  const milliseconds = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

export function automationRunFromBackend(
  run: ProjectAutomationRun,
  rule: AutomationUiRule
): AutomationUiRun {
  return {
    id: run.id,
    ruleId: rule.id,
    ruleName: rule.name,
    issue: run.taskTitle || run.taskId || (run.trigger === 'scheduled' ? '计划运行' : '手动运行'),
    status: run.status,
    triggeredAt: run.createdAt,
    startedAt: new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(run.createdAt)),
    duration: runDuration(run),
  }
}
