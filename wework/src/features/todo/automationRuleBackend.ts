export {
  automationInputFromUi,
  legacyWorkflowFromAutomationRule,
} from './automationRuleSerialization'
import { parseCron } from './automationSchedule'
import type {
  ProjectAutomationEventType,
  ProjectAutomationRule,
  ProjectAutomationRun,
} from '@/api/projectAutomations'
import type { ProjectEventCollectionMode, ProjectEventSourceType } from '@/api/projectIncomingHooks'
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
  assigneeUserId?: number | null
  id: string
  name: string
  prompt: string
  kind: 'task' | 'dynamic' | 'loop' | 'branch'
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
  nodeType?: 'task' | 'event' | 'loop' | 'loopStart' | 'branch' | 'loopEnd'
  role?: 'start' | null
  loopId?: string | null
  bodyNodeIds?: string[]
  loopConfig?: {
    maxAttempts: number
    timeoutSeconds: number | null
  } | null
  branchConditions?: Array<{
    sourceType: BranchSourceType
    eventType: string
    handlerNodeIds: string[]
  }>
  eventWait?: {
    collectionMode: Extract<ProjectEventCollectionMode, 'webhook' | 'poll'>
    subscriptionId: string | null
    pollIntervalSeconds: number | null
  } | null
  subgraph: AutomationUiGraph | null
}

export interface AutomationUiGraph {
  nodes: AutomationUiStep[]
}

export interface AutomationUiTrigger {
  type: 'event' | 'schedule' | 'workflow'
  source: ProjectEventSourceType
  collectionMode?: ProjectEventCollectionMode
  startMode: 'immediate' | 'status'
  event:
    | 'created'
    | 'status_changed'
    | Exclude<ProjectAutomationEventType, 'task.created' | 'task.status_changed'>
  tags: string[]
  subscriptionId?: string | null
  pollIntervalSeconds?: number
  targetBranches?: string[]
  repositories?: string[]
  schedule: {
    frequency: 'hourly' | 'daily' | 'weekdays' | 'weekly'
    weekday: string
    time: string
    timezone: string
  }
}

export interface AutomationUiRule {
  advancement: 'sequential' | 'ai'
  coordinator: AutomationUiStep | null
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
  runtimeSource?: 'agent_default' | 'fixed_profile' | 'issue_creator' | 'runtime_user'
  runtimeUserId?: number | null
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

interface NormalizedAutomationFlowV2 {
  version: 2
  description: string
  graph: AutomationUiGraph
  advancement?: 'sequential' | 'ai'
  coordinator?: AutomationUiStep | null
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
  const kind =
    item.kind === 'dynamic' || item.kind === 'loop' || item.kind === 'branch' ? item.kind : 'task'
  const nodeType =
    item.nodeType === 'event' ||
    item.nodeType === 'loop' ||
    item.nodeType === 'loopStart' ||
    item.nodeType === 'branch' ||
    item.nodeType === 'loopEnd'
      ? item.nodeType
      : kind === 'loop'
        ? 'loop'
        : kind === 'branch'
          ? 'branch'
          : 'task'
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
    assigneeUserId: typeof item.assigneeUserId === 'number' ? item.assigneeUserId : null,
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
    nodeType,
    role: item.role === 'start' ? 'start' : null,
    loopId: typeof item.loopId === 'string' ? item.loopId : null,
    bodyNodeIds: stringArray(item.bodyNodeIds),
    loopConfig:
      isRecord(item.loopConfig) &&
      (typeof item.loopConfig.maxAttempts === 'number' ||
        item.loopConfig.timeoutSeconds === null ||
        typeof item.loopConfig.timeoutSeconds === 'number')
        ? {
            maxAttempts:
              typeof item.loopConfig.maxAttempts === 'number'
                ? Math.max(0, item.loopConfig.maxAttempts)
                : 5,
            timeoutSeconds:
              typeof item.loopConfig.timeoutSeconds === 'number'
                ? Math.max(1, item.loopConfig.timeoutSeconds)
                : null,
          }
        : null,
    branchConditions: recordArray(item.branchConditions).map(condition => ({
      sourceType:
        normalizeBranchSourceType(condition.sourceType ?? condition.source_type) || 'github',
      eventType: typeof condition.eventType === 'string' ? condition.eventType : '',
      handlerNodeIds: stringArray(condition.handlerNodeIds),
    })),
    eventWait: (() => {
      const stored = isRecord(item.eventWait) ? item.eventWait : null
      const legacyCondition = recordArray(item.branchConditions)[0]
      const collectionMode = normalizeBranchCollectionMode(
        stored?.collectionMode ?? stored?.collection_mode ?? legacyCondition?.collectionMode
      )
      return nodeType === 'branch'
        ? {
            collectionMode: collectionMode || 'poll',
            subscriptionId:
              typeof stored?.subscriptionId === 'string'
                ? stored.subscriptionId
                : typeof stored?.subscription_id === 'string'
                  ? stored.subscription_id
                  : null,
            pollIntervalSeconds:
              typeof stored?.pollIntervalSeconds === 'number'
                ? Math.max(60, stored.pollIntervalSeconds)
                : 300,
          }
        : null
    })(),
    subgraph: null,
  }
  if (kind === 'dynamic') {
    step.subgraph = {
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
  } else if (kind === 'loop') {
    step.subgraph = {
      nodes: subgraphNodes.map((node, childIndex) => normalizeStoredStep(node, childIndex)),
    }
  }
  return step
}

function storedFlow(rule: ProjectAutomationRule): NormalizedAutomationFlowV2 | null {
  const candidate = rule.eventConfig[FLOW_KEY]
  if (!isRecord(candidate)) {
    return null
  }
  if (
    (candidate.version === 2 || candidate.version === 3) &&
    isRecord(candidate.graph) &&
    Array.isArray(candidate.graph.nodes)
  ) {
    return {
      version: 2,
      advancement:
        candidate.advancement === 'ai' ? 'ai' : candidate.version === 3 ? 'sequential' : undefined,
      coordinator: isRecord(candidate.coordinator)
        ? normalizeStoredStep(candidate.coordinator, 0)
        : null,
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
      nodes: legacy.steps.map((step, index) => {
        const node = normalizeStoredStep(step, index)
        if (index > 0 && isRecord(step) && !Array.isArray(step.dependencies)) {
          node.dependencies = [normalizeStoredStep(legacy.steps[index - 1], index - 1).id]
        }
        return node
      }),
    },
  }
}

function fallbackStep(rule: ProjectAutomationRule): AutomationUiStep {
  const agentId = rule.roleSource === 'generic' ? null : rule.agentId
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
    workspacePolicy: 'none',
    required: true,
    automationRuleId: rule.triggerType === 'workflow' ? rule.id : null,
    executionConfig: agentId
      ? {
          agent_id: agentId,
          runtime_profile_id: rule.runtimeProfileId ?? null,
          execution_device_id: rule.executionDeviceId,
          model: rule.model,
          model_type: null,
          model_options: {},
          workspace_binding: {
            type: 'standalone',
          },
        }
      : null,
    executionConfigOverride: false,
    subgraph: rule.assignmentMode === 'ai_managed' ? { nodes: [] } : null,
  }
}

const TRIGGER_SOURCE_TYPES = new Set<ProjectEventSourceType>([
  'github',
  'gitlab',
  'wework',
  'generic',
])

type BranchCollectionMode = Extract<ProjectEventCollectionMode, 'webhook' | 'poll'>
type BranchSourceType = Extract<ProjectEventSourceType, 'github' | 'gitlab'>

const BRANCH_COLLECTION_MODES = new Set<BranchCollectionMode>(['webhook', 'poll'])
const BRANCH_SOURCE_TYPES = new Set<BranchSourceType>(['github', 'gitlab'])

function normalizeBranchSourceType(value: unknown): BranchSourceType | '' {
  return typeof value === 'string' && BRANCH_SOURCE_TYPES.has(value as BranchSourceType)
    ? (value as BranchSourceType)
    : ''
}

function normalizeBranchCollectionMode(value: unknown): BranchCollectionMode | '' {
  return typeof value === 'string' && BRANCH_COLLECTION_MODES.has(value as BranchCollectionMode)
    ? (value as BranchCollectionMode)
    : ''
}

function normalizeTriggerSource(rule: ProjectAutomationRule): ProjectEventSourceType {
  const stored = rule.eventConfig.source_type ?? rule.eventConfig.sourceType
  if (typeof stored === 'string' && TRIGGER_SOURCE_TYPES.has(stored as ProjectEventSourceType)) {
    return stored as ProjectEventSourceType
  }
  if (rule.eventType === 'task.created' || rule.eventType === 'task.status_changed') {
    return 'wework'
  }
  const subscriptionId =
    typeof rule.eventConfig.subscription_id === 'string'
      ? rule.eventConfig.subscription_id
      : typeof rule.eventConfig.subscriptionId === 'string'
        ? rule.eventConfig.subscriptionId
        : null
  return subscriptionId ? 'generic' : 'wework'
}

function normalizeCollectionMode(rule: ProjectAutomationRule): ProjectEventCollectionMode {
  const stored = rule.eventConfig.collection_mode ?? rule.eventConfig.collectionMode
  if (stored === 'webhook' || stored === 'poll' || stored === 'hybrid') return stored
  return 'webhook'
}

export function automationRuleFromBackend(rule: ProjectAutomationRule): AutomationUiRule {
  const flow = storedFlow(rule)
  const definition =
    !flow && rule.eventConfig.runtime_workflow_definition
      ? (rule.eventConfig.runtime_workflow_definition as ProjectWorkflowDefinition)
      : null
  const config = definition?.execution_config
  const generatedCoordinator =
    definition?.advancement_policy === 'ai'
      ? {
          ...fallbackStep(rule),
          kind: 'task' as const,
          subgraph: null,
          prompt: definition.coordinator_prompt ?? rule.prompt,
          automationRuleId: rule.id,
          executionConfig: config ?? null,
          executionDeviceId: config?.execution_device_id ?? null,
          runtimeProfileId: config?.runtime_profile_id ?? null,
          model: config?.model ?? '',
          modelType: config?.model_type ?? null,
          modelOptions: config?.model_options ?? {},
        }
      : null
  const storedNodes = flow ? flow.graph.nodes : [fallbackStep(rule)]
  const oldCoordinator =
    storedNodes.length === 1 && storedNodes[0]?.kind === 'dynamic' ? storedNodes[0] : null
  const schedule = parseCron(rule.cronExpression)
  const startMode = rule.eventType === 'task.status_changed' ? 'status' : 'immediate'
  const subscriptionId =
    typeof rule.eventConfig.subscription_id === 'string'
      ? rule.eventConfig.subscription_id
      : typeof rule.eventConfig.subscriptionId === 'string'
        ? rule.eventConfig.subscriptionId
        : null
  const externalEvent =
    rule.eventType && rule.eventType !== 'task.created' && rule.eventType !== 'task.status_changed'
      ? rule.eventType
      : null
  const source = normalizeTriggerSource(rule)
  return {
    advancement:
      flow?.advancement ?? (generatedCoordinator || oldCoordinator ? 'ai' : 'sequential'),
    coordinator: flow?.coordinator ?? generatedCoordinator ?? oldCoordinator,
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
      type: rule.triggerType,
      source,
      collectionMode: normalizeCollectionMode(rule),
      startMode,
      event: externalEvent ?? (startMode === 'status' ? 'status_changed' : 'created'),
      tags: Array.isArray(rule.eventConfig.tags)
        ? rule.eventConfig.tags.filter((value): value is string => typeof value === 'string')
        : [],
      subscriptionId,
      pollIntervalSeconds:
        typeof rule.eventConfig.poll_interval_seconds === 'number'
          ? Math.max(60, rule.eventConfig.poll_interval_seconds)
          : 300,
      targetBranches: stringArray(
        rule.eventConfig.target_branches ?? rule.eventConfig.targetBranches
      ),
      repositories: stringArray(rule.eventConfig.repositories),
      schedule: {
        ...schedule,
        timezone: rule.timezone,
      },
    },
    steps: definition
      ? workflowNodesFromLegacy(definition, [rule])
      : oldCoordinator
        ? (oldCoordinator.subgraph?.nodes ?? [])
        : storedNodes,
    legacyDefinition: definition,
    runtimeSource: rule.runtimeSource,
    runtimeUserId: rule.runtimeUserId,
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
  const bodyByLoop = new Map<string, WorkflowNodeDefinition[]>()
  for (const node of definition.nodes) {
    if (!node.loop_id) continue
    const body = bodyByLoop.get(node.loop_id) ?? []
    body.push(node)
    bodyByLoop.set(node.loop_id, body)
  }
  const toStep = (node: WorkflowNodeDefinition, rowOverride?: number): AutomationUiStep => {
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
      kind: node.node_type === 'loop' ? 'loop' : node.node_type === 'branch' ? 'branch' : 'task',
      nodeType:
        node.node_type === 'event'
          ? 'event'
          : node.node_type === 'loop'
            ? 'loop'
            : node.node_type === 'loop_start'
              ? 'loopStart'
              : node.node_type === 'branch'
                ? 'branch'
                : node.node_type === 'loop_end'
                  ? 'loopEnd'
                  : 'task',
      role: node.role === 'start' ? 'start' : null,
      loopId: node.loop_id ?? null,
      bodyNodeIds: [...(node.body_node_ids ?? [])],
      loopConfig: node.loop_config
        ? {
            maxAttempts: node.loop_config.max_attempts ?? 5,
            timeoutSeconds: node.loop_config.timeout_seconds ?? null,
          }
        : null,
      branchConditions: (node.branch_conditions ?? []).map(condition => ({
        sourceType: normalizeBranchSourceType(condition.source_type) || 'github',
        eventType: condition.event_type,
        handlerNodeIds: [...(condition.handler_node_ids ?? [])],
      })),
      eventWait:
        node.node_type === 'branch'
          ? {
              collectionMode:
                normalizeBranchCollectionMode(node.event_wait?.collection_mode) || 'poll',
              subscriptionId: node.event_wait?.subscription_id ?? null,
              pollIntervalSeconds:
                node.event_wait?.poll_interval_seconds ??
                (node.event_wait?.collection_mode === 'webhook' ? null : 300),
            }
          : null,
      dependencies: [...node.depends_on].filter(dependencyId => dependencyId !== 'start'),
      dependencyContext: { ...(node.dependency_context ?? {}) },
      x: 440 + (rowOverride ?? depth) * 420,
      y: 150 + (rowOverride ?? row) * 150,
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
      assigneeUserId: node.assignee_user_id ?? null,
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
  }
  const steps: AutomationUiStep[] = []
  for (const node of definition.nodes) {
    if (node.node_type === 'event' || node.loop_id) continue
    if (node.node_type === 'loop') {
      const bodyNodes = bodyByLoop.get(node.id) ?? []
      steps.push({
        ...toStep(node),
        subgraph: { nodes: bodyNodes.map((bodyNode, index) => toStep(bodyNode, index)) },
      })
      continue
    }
    steps.push(toStep(node))
  }
  return steps
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
    advancement: advancementPolicy === 'ai' ? 'ai' : 'sequential',
    coordinator: advancementPolicy === 'ai' ? { ...steps[0]!, kind: 'task', subgraph: null } : null,
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
      source: 'wework',
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
    steps: workflowNodes,
    legacyDefinition: definition,
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
