import { describe, expect, test } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import type { ProjectAutomationRule, ProjectAutomationRun } from '@/api/projectAutomations'
import {
  automationInputFromUi,
  automationRunFromBackend,
  automationRuleFromLegacyWorkflow,
  automationRuleFromBackend,
  legacyWorkflowFromAutomationRule,
  type AutomationUiRule,
} from './automationRuleBackend'

function backendRule(overrides: Partial<ProjectAutomationRule> = {}): ProjectAutomationRule {
  return {
    id: 'rule-1',
    projectId: '11',
    name: '状态触发开发',
    prompt: '执行开发流程',
    triggerType: 'event',
    eventType: 'task.status_changed',
    eventConfig: {
      transition: 'entered_processing',
      tags: ['自动开发'],
    },
    webhookEventId: null,
    webhookSecret: null,
    cronExpression: null,
    timezone: 'Asia/Shanghai',
    assignmentMode: 'manual',
    managerType: null,
    agentId: null,
    wegentTeamId: null,
    model: null,
    agentName: '自动化执行器',
    executionEnvironment: 'local',
    executionDeviceId: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    version: 1,
    createdAt: '2026-08-25T02:00:00Z',
    updatedAt: '2026-08-25T02:00:00Z',
    roleSource: 'generic',
    runtimeSource: 'runtime_user',
    runtimeProfileId: null,
    runtimeUserId: 7,
    ...overrides,
  }
}

function uiRule(): AutomationUiRule {
  return {
    id: 'draft-1',
    persisted: false,
    version: 1,
    name: 'Issue 自动开发',
    description: '创建后完成开发流程',
    enabled: true,
    updatedAt: '尚未发布',
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    trigger: {
      type: 'event',
      source: 'issue',
      startMode: 'status',
      event: 'status_changed',
      tags: ['自动开发'],
      schedule: {
        frequency: 'daily',
        weekday: 'monday',
        time: '03:00',
        timezone: 'Asia/Shanghai',
      },
    },
    steps: [
      {
        id: 'step-1',
        name: '实现与验证',
        prompt: '修改代码并运行测试',
        kind: 'task',
        dependencies: [],
        x: 440,
        y: 226,
        deliverables: [],
        executionMode: 'automatic',
        environment: '本机执行器 · 在线',
        executionEnvironment: 'local',
        executionDeviceId: 'device-1',
        runtimeProfileId: null,
        model: 'codex-runtime',
        modelType: 'runtime',
        modelOptions: { reasoning: 'high' },
        plugins: ['Wework 项目空间'],
        projectPlugins: [
          {
            id: 'plugin-1',
            pluginName: 'wework-space',
            marketplaceId: 'market-1',
            displayName: 'Wework 项目空间',
          },
        ],
        workspacePolicy: 'none',
        required: true,
        subgraph: null,
      },
    ],
    origin: 'automation',
    legacyDefinition: null,
  }
}

describe('automationRuleBackend', () => {
  test.each([
    ['pending', '—'],
    ['queued', '—'],
    ['waiting_runtime', '—'],
    ['waiting_device', '—'],
    ['running', '进行中'],
  ] satisfies Array<[ProjectAutomationRun['status'], string]>)(
    'preserves the backend %s run state instead of presenting it as running',
    (status, duration) => {
      const run: ProjectAutomationRun = {
        id: `run-${status}`,
        automationId: 'rule-1',
        projectId: '11',
        trigger: 'event',
        status,
        timezone: 'Asia/Shanghai',
        scheduledFor: '2026-08-26T10:00:00Z',
        expiresAt: null,
        taskId: 'issue-1',
        taskTitle: '真实执行状态',
        backendTaskId: null,
        deviceId: null,
        error: null,
        createdAt: '2026-08-26T10:00:00Z',
        updatedAt: '2026-08-26T10:00:00Z',
        completedAt: null,
      }

      expect(automationRunFromBackend(run, uiRule())).toMatchObject({
        status,
        duration,
      })
    }
  )

  test('maps status-change rules without changing their trigger semantics', () => {
    const mapped = automationRuleFromBackend(backendRule())

    expect(mapped.trigger.startMode).toBe('status')
    expect(mapped.trigger.event).toBe('status_changed')
  })

  test('formats automation timestamps in Asia/Shanghai', () => {
    const mapped = automationRuleFromBackend(backendRule({ updatedAt: '2026-08-26T09:18:00Z' }))

    expect(mapped.updatedAt).toBe('2026/08/26 17:18')
  })

  test('persists the complete node execution configuration in the backend rule', () => {
    const input = automationInputFromUi(uiRule(), 7)
    const storedFlow = input.eventConfig.wework_flow as {
      version: number
      graph: {
        nodes: AutomationUiRule['steps']
      }
    }

    expect(input.eventType).toBe('task.status_changed')
    expect(input.eventConfig.transition).toBe('entered_processing')
    expect(input.eventConfig).not.toHaveProperty('statuses')
    expect(storedFlow.version).toBe(2)
    expect(storedFlow.graph.nodes[0]).toMatchObject({
      executionDeviceId: 'device-1',
      model: 'codex-runtime',
      modelType: 'runtime',
      modelOptions: { reasoning: 'high' },
      plugins: ['Wework 项目空间'],
    })
    const runtimeWorkflow = input.eventConfig.runtime_workflow_definition as {
      nodes: Array<{ execution_config: { workspace_binding: { type: string } } }>
    }
    expect(runtimeWorkflow.nodes[0].execution_config.workspace_binding).toEqual({
      type: 'standalone',
    })
  })

  test('converts schedule settings into the backend cron contract', () => {
    const rule = uiRule()
    rule.trigger = {
      ...rule.trigger,
      type: 'schedule',
      schedule: {
        frequency: 'weekdays',
        weekday: 'monday',
        time: '09:30',
        timezone: 'Asia/Shanghai',
      },
    }

    const input = automationInputFromUi(rule, 7)

    expect(input.triggerType).toBe('schedule')
    expect(input.eventType).toBeNull()
    expect(input.cronExpression).toBe('30 9 * * 1-5')
  })

  test('uses a standalone conversation when scheduled automation has no project workspace', () => {
    const rule = uiRule()
    rule.trigger = {
      ...rule.trigger,
      type: 'schedule',
    }
    rule.steps = [
      {
        ...rule.steps[0],
        workspacePolicy: 'composer',
        executionConfig: {
          agent_id: null,
          runtime_profile_id: null,
          execution_device_id: 'device-1',
          model: 'codex-runtime',
          model_type: 'runtime',
          model_options: { reasoning: 'high' },
          workspace_binding: null,
        },
      },
    ]

    const input = automationInputFromUi(rule, 7)
    const runtimeWorkflow = input.eventConfig.runtime_workflow_definition as {
      nodes: Array<{ execution_config: { workspace_binding: { type: string } } }>
    }

    expect(runtimeWorkflow.nodes[0].execution_config.workspace_binding).toEqual({
      type: 'standalone',
    })
  })

  test('persists empty AI dynamic allocation as unconstrained Issue planning', () => {
    const rule = uiRule()
    rule.steps = [
      {
        ...rule.steps[0],
        kind: 'dynamic',
        name: 'AI 动态分配',
        approvalPolicy: 'automatic',
        subgraph: { nodes: [] },
      },
    ]

    const input = automationInputFromUi(rule, 7)

    expect(input.eventConfig.runtime_workflow_definition).toMatchObject({
      stage_mode: 'none',
      advancement_policy: 'ai',
      approval_policy: 'automatic',
      nodes: [],
    })
    expect(input.assignmentMode).toBe('ai_managed')
    expect(input.managerType).toBe('custom')
  })

  test('keeps the AI dynamic allocation DAG when the automation is disabled', () => {
    const rule = uiRule()
    const stage = {
      ...rule.steps[0],
      id: 'analysis',
      name: '分析需求',
      executionConfigOverride: true,
    }
    rule.enabled = false
    rule.steps = [
      {
        ...rule.steps[0],
        kind: 'dynamic',
        name: 'AI 动态分配',
        subgraph: { nodes: [stage] },
      },
    ]

    const input = automationInputFromUi(rule, 7)

    expect(input.eventConfig.runtime_workflow_definition).toMatchObject({
      stage_mode: 'dag',
      advancement_policy: 'ai',
      nodes: [
        expect.objectContaining({
          id: 'analysis',
          execution_config: null,
          execution_config_override: false,
        }),
      ],
    })
    const storedFlow = input.eventConfig.wework_flow as {
      graph: { nodes: Array<{ subgraph: { nodes: Array<Record<string, unknown>> } }> }
    }
    expect(storedFlow.graph.nodes[0].subgraph.nodes[0]).not.toHaveProperty('model')
    expect(storedFlow.graph.nodes[0].subgraph.nodes[0]).not.toHaveProperty('executionDeviceId')
    expect(storedFlow.graph.nodes[0].subgraph.nodes[0]).not.toHaveProperty('plugins')
  })

  test('projects and round-trips the legacy Issue workflow without losing node execution data', () => {
    const workflowRule = backendRule({
      id: 'workflow-rule-1',
      triggerType: 'workflow',
      eventType: null,
      runtimeProfileId: 'profile-1',
    })
    const project = {
      id: 11,
      name: 'Legacy project',
      version: 9,
      updated_at: '2026-08-25T02:00:00Z',
      workflow_definition: {
        version: 3,
        stage_mode: 'dag',
        advancement_policy: 'manual',
        coordinator_prompt: '',
        approval_policy: 'required',
        ai_automation_rule_id: null,
        execution_config: null,
        nodes: [
          {
            id: 'analysis',
            name: '分析需求',
            prompt: '分析 Issue',
            execution_mode: 'robot',
            depends_on: [],
            dependency_context: {},
            required: true,
            required_deliverables: [
              {
                id: 'analysis-result',
                name: '分析结果',
                description: '结构化需求分析',
                value_type: 'text',
              },
            ],
            workspace_policy: 'composer',
            automation_rule_id: 'workflow-rule-1',
            execution_config: {
              agent_id: null,
              runtime_profile_id: 'profile-1',
              execution_device_id: 'device-1',
              model: 'codex-runtime',
              model_type: 'runtime',
              model_options: { reasoning: 'high' },
              workspace_binding: { type: 'standalone' },
              project_plugins: [
                {
                  id: 'plugin-1',
                  pluginName: 'wework-space',
                  marketplaceId: 'market-1',
                  displayName: 'Wework 项目空间',
                },
              ],
            },
            execution_config_override: true,
          },
        ],
      },
    } as CloudProject

    const mapped = automationRuleFromLegacyWorkflow(project, [workflowRule])

    expect(mapped).not.toBeNull()
    expect(mapped?.origin).toBe('legacy_workflow')
    expect(mapped?.steps[0]).toMatchObject({
      id: 'analysis',
      dependencies: [],
      executionMode: 'automatic',
      executionDeviceId: 'device-1',
      runtimeProfileId: 'profile-1',
      model: 'codex-runtime',
      automationRuleId: 'workflow-rule-1',
      executionConfigOverride: true,
    })
    expect(legacyWorkflowFromAutomationRule(mapped!)).toMatchObject(project.workflow_definition)
  })
})

test.each([0, 17, 59])('round trips hourly schedules at minute %s', minute => {
  const expression = `${minute} * * * *`
  const ui = automationRuleFromBackend(
    backendRule({
      triggerType: 'schedule',
      cronExpression: expression,
      timezone: 'UTC',
    })
  )
  expect(ui.trigger.schedule).toMatchObject({
    frequency: 'hourly',
    time: `00:${String(minute).padStart(2, '0')}`,
    timezone: 'UTC',
  })
  expect(automationInputFromUi(ui, 7)).toMatchObject({
    cronExpression: expression,
    timezone: 'UTC',
    triggerType: 'schedule',
  })
})
