import type { ProjectAutomationEventType, ProjectAutomationInput } from '@/api/projectAutomations'
import type {
  ProjectWorkflowDefinition,
  WorkflowExecutionConfig,
  WorkflowNodeDefinition,
} from '@/api/deliveries'
import type { AutomationUiRule, AutomationUiStep } from './automationRuleBackend'
import { buildCron } from './automationSchedule'

interface StoredAutomationFlowV2 {
  version: 3
  advancement: 'sequential' | 'ai'
  coordinator: unknown
  description: string
  graph: {
    nodes: unknown[]
  }
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
        : preserved.workspace_binding,
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
    node_type:
      node.nodeType === 'event'
        ? 'event'
        : node.nodeType === 'loop'
          ? 'loop'
          : node.nodeType === 'loopStart'
            ? 'loop_start'
            : node.nodeType === 'branch'
              ? 'branch'
              : node.nodeType === 'loopEnd'
                ? 'loop_end'
                : 'task',
    role: node.role === 'start' ? 'start' : undefined,
    loop_id: node.loopId ?? undefined,
    body_node_ids: node.nodeType === 'loop' ? [...(node.bodyNodeIds ?? [])] : undefined,
    loop_config:
      node.nodeType === 'loop' && node.loopConfig
        ? {
            max_attempts: node.loopConfig.maxAttempts,
            timeout_seconds: node.loopConfig.timeoutSeconds,
          }
        : undefined,
    branch_conditions:
      node.nodeType === 'branch'
        ? (node.branchConditions ?? []).map(condition => ({
            source_type: condition.sourceType,
            event_type: condition.eventType,
            handler_node_ids: [...condition.handlerNodeIds],
          }))
        : undefined,
    event_wait:
      node.nodeType === 'branch'
        ? {
            subject_source: 'upstream_pull_request',
            collection_mode: node.eventWait?.collectionMode ?? 'poll',
            ...(node.eventWait?.collectionMode === 'webhook'
              ? { subscription_id: node.eventWait?.subscriptionId ?? null }
              : {}),
            poll_interval_seconds:
              node.eventWait?.collectionMode === 'webhook'
                ? null
                : (node.eventWait?.pollIntervalSeconds ?? 300),
          }
        : undefined,
    execution_mode: node.executionMode === 'automatic' ? 'robot' : 'human',
    assignee_user_id: node.assigneeUserId ?? null,
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
  const coordinator = rule.advancement === 'ai' ? rule.coordinator : null
  const previous = rule.legacyDefinition
  if (coordinator) {
    return {
      version: Math.max(1, previous?.version ?? 1),
      stage_mode: rule.steps.length ? 'dag' : 'none',
      advancement_policy: 'ai',
      coordinator_prompt: coordinator.prompt,
      approval_policy: 'automatic',
      ai_automation_rule_id: coordinator.automationRuleId,
      execution_config: executionConfigFromUiNode(coordinator),
      nodes: rule.steps.map(node => workflowNodeFromUi(node)),
    }
  }
  const startConfig = ((): WorkflowNodeDefinition['start_config'] => {
    if (rule.trigger.type === 'event') {
      return {
        trigger_type: 'event',
        event_type: rule.trigger.event ?? null,
        cron_expression: null,
        source_type: rule.trigger.source ?? null,
      }
    }
    if (rule.trigger.type === 'workflow') return undefined
    return {
      trigger_type: 'schedule',
      event_type: null,
      cron_expression: buildCron(rule.trigger),
      source_type: null,
    }
  })()
  const loopNodes: WorkflowNodeDefinition[] = []
  const topLevelNodes: WorkflowNodeDefinition[] = rule.steps.flatMap(step => {
    if (step.kind !== 'loop') {
      return [workflowNodeFromUi(step)]
    }
    const bodySteps = step.subgraph?.nodes ?? []
    const bodyNodes = bodySteps.map(bodyStep => ({
      ...workflowNodeFromUi(bodyStep),
      node_type:
        bodyStep.nodeType === 'loopStart'
          ? ('loop_start' as const)
          : bodyStep.nodeType === 'branch'
            ? ('branch' as const)
            : bodyStep.nodeType === 'loopEnd'
              ? ('loop_end' as const)
              : ('task' as const),
      loop_id: step.id,
      depends_on: bodyStep.nodeType === 'loopStart' ? [] : [...(bodyStep.dependencies ?? [])],
    }))
    loopNodes.push(...bodyNodes)
    return [
      {
        ...workflowNodeFromUi(step),
        node_type: 'loop' as const,
        body_node_ids: bodyNodes.map(bodyNode => bodyNode.id),
        depends_on: step.dependencies.length > 0 ? [...step.dependencies] : ['start'],
      },
    ]
  })
  const startNode: WorkflowNodeDefinition = {
    id: 'start',
    name: '开始',
    prompt: '',
    node_type: 'event',
    role: 'start',
    start_config: startConfig,
    execution_mode: 'human',
    depends_on: [],
    dependency_context: {},
    required: false,
    required_deliverables: [],
    workspace_policy: 'none',
    automation_rule_id: null,
    execution_config: null,
    execution_config_override: false,
  }
  const rewired = topLevelNodes.map(node => ({
    ...node,
    depends_on:
      node.node_type !== 'loop' && node.depends_on.length === 0 ? ['start'] : node.depends_on,
  }))
  return {
    version: Math.max(1, previous?.version ?? 1),
    stage_mode: rule.steps.length ? 'dag' : 'none',
    advancement_policy: 'manual',
    coordinator_prompt: previous?.coordinator_prompt ?? '',
    approval_policy: previous?.approval_policy ?? 'required',
    ai_automation_rule_id: null,
    execution_config: previous?.execution_config ?? null,
    nodes: [startNode, ...rewired, ...loopNodes],
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
      node.kind === 'loop' ? { nodes: (node.subgraph?.nodes ?? []).map(storedStepFromUi) } : null,
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
        (step.kind === 'dynamic' || step.kind === 'loop') && step.subgraph?.nodes.length
          ? `\n子图：\n${describeNodes(step.subgraph.nodes, depth + 1).join('\n')}`
          : ''
      return `${'  '.repeat(depth)}${index + 1}. ${step.name}\n${'  '.repeat(depth)}${step.prompt}${deliverables}${dependencies}${subgraph}`
    })
  const steps = describeNodes(rule.steps)
  const description = rule.description.trim()
  return [
    ...(description ? [`自动化目标：${description}`] : []),
    rule.advancement === 'ai'
      ? '以下节点代表可交办工作的角色，连线是协作经验。按工单要求选择角色，允许跳过和退回，以满足要求为完成标准。'
      : '严格按以下顺序交办工作，当前角色完成后再启动下一角色：',
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
  if (rule.steps.some(node => node.kind === 'dynamic')) {
    throw new Error('请删除旧的嵌套 AI 节点，并在自动化层设置推进方式与协调者，再配置执行角色')
  }
  const eventTrigger = rule.trigger.type === 'event'
  const isAiDynamicWorkflow = rule.advancement === 'ai'
  if (isAiDynamicWorkflow && !rule.coordinator) throw new Error('AI 推进需要配置协调者')
  if (
    !isAiDynamicWorkflow &&
    !rule.steps.some(node => node.kind === 'loop' || node.kind === 'branch') &&
    rule.steps.some(
      (node, index) =>
        node.dependencies.length !== (index === 0 ? 0 : 1) ||
        (index > 0 && node.dependencies[0] !== rule.steps[index - 1]?.id)
    )
  )
    throw new Error('流程推进必须按串行顺序交办，请重新排列角色')
  const externalEventTrigger = eventTrigger && rule.trigger.source !== 'wework'
  const directStep =
    !isAiDynamicWorkflow && rule.steps.length === 1 && rule.steps[0]?.executionMode === 'automatic'
      ? rule.steps[0]
      : null
  const directConfig = directStep ? executionConfigFromUiNode(directStep) : null
  const directAgentId = directConfig?.agent_id ?? null
  const runtimeProfileId = directConfig?.runtime_profile_id ?? null
  const description = rule.description.trim()
  return {
    name: rule.name.trim(),
    prompt: flowPrompt(rule),
    triggerType: rule.trigger.type,
    eventType: externalEventTrigger
      ? (rule.trigger.event as ProjectAutomationEventType)
      : eventTrigger
        ? rule.trigger.startMode === 'status'
          ? 'task.status_changed'
          : 'task.created'
        : null,
    eventConfig: {
      ...(externalEventTrigger
        ? {
            source_type: rule.trigger.source,
            collection_mode: rule.trigger.collectionMode ?? 'webhook',
            subscription_id: rule.trigger.subscriptionId,
            execution_target: 'create_issue',
            poll_interval_seconds:
              rule.trigger.collectionMode === 'poll'
                ? (rule.trigger.pollIntervalSeconds ?? 300)
                : undefined,
            target_branches: rule.trigger.targetBranches ?? [],
            repositories: rule.trigger.repositories ?? [],
          }
        : {
            tags: rule.trigger.tags,
            ...(rule.trigger.startMode === 'status' ? { transition: 'entered_processing' } : {}),
          }),
      runtime_workflow_definition: legacyWorkflowFromAutomationRule(rule),
      wework_flow: {
        version: 3,
        advancement: rule.advancement,
        coordinator: rule.coordinator
          ? storedStepFromUi({ ...rule.coordinator, kind: 'task', subgraph: null })
          : null,
        description,
        graph: {
          nodes: rule.steps.map(storedStepFromUi),
        },
      } satisfies StoredAutomationFlowV2,
    },
    cronExpression: rule.trigger.type === 'schedule' ? buildCron(rule.trigger) : null,
    timezone: rule.trigger.schedule.timezone,
    enabled: rule.enabled,
    assignmentMode: isAiDynamicWorkflow ? 'ai_managed' : 'manual',
    managerType: isAiDynamicWorkflow ? 'custom' : null,
    agentId: directAgentId,
    wegentTeamId: null,
    model: directAgentId ? null : (directConfig?.model ?? null),
    executionEnvironment: directAgentId ? null : (directStep?.executionEnvironment ?? null),
    executionDeviceId: directAgentId ? null : (directConfig?.execution_device_id ?? null),
    roleSource: directAgentId ? 'agent' : 'generic',
    runtimeSource: directAgentId
      ? 'agent_default'
      : (rule.runtimeSource ?? (runtimeProfileId !== null ? 'fixed_profile' : 'runtime_user')),
    runtimeProfileId: directAgentId ? null : runtimeProfileId,
    runtimeUserId: rule.runtimeUserId ?? runtimeUserId,
  }
}
