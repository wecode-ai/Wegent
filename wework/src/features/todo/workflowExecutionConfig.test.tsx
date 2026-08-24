import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, IssueWorkflowInstance } from '@/api/deliveries'
import { CloudTodoCardContent } from './CloudTodoBoardCard'
import {
  effectiveWorkflowNodeExecutionConfig,
  itemNeedsExecutionConfiguration,
  mergeWorkflowExecutionConfig,
  resolveWorkflowExecutionConfig,
  workflowExecutionConfigComplete,
  workflowNeedsExecutionConfiguration,
} from './workflowExecutionConfig'

const completeConfig = {
  agent_id: null,
  runtime_profile_id: null,
  execution_device_id: 'device-1',
  model: 'model-1',
  workspace_binding: { type: 'standalone' as const },
}

function workflow(config = completeConfig): IssueWorkflowInstance {
  return {
    version: 1,
    definition_version: 1,
    stage_mode: 'dag',
    advancement_policy: 'manual',
    execution_config: config,
    nodes: [
      {
        id: 'stage-1',
        name: 'Build',
        depends_on: [],
        required: true,
        workspace_policy: 'composer',
        automation_rule_id: 'rule-1',
        status: 'ready',
      },
    ],
  }
}

describe('workflow execution configuration', () => {
  it('accepts direct machine and model execution in a standalone conversation', () => {
    expect(
      workflowExecutionConfigComplete({
        agent_id: null,
        runtime_profile_id: null,
        execution_device_id: 'device-1',
        model: 'model-1',
        workspace_binding: { type: 'standalone' },
      })
    ).toBe(true)
  })

  it('resolves missing fields from the selected custom robot', () => {
    expect(
      resolveWorkflowExecutionConfig(
        {
          agent_id: 'agent-1',
          runtime_profile_id: null,
          execution_device_id: null,
          model: null,
          workspace_binding: null,
        },
        [
          {
            id: 'agent-1',
            model: 'custom-model',
            defaultRuntimeProfileId: null,
            executionDeviceId: 'device-1',
            localProjectId: null,
            workspaceBinding: {
              type: 'device_project',
              status: 'ready',
              deviceId: 'device-1',
              runtimeProjectKey: 'project-1',
            },
          } as never,
        ],
        []
      )
    ).toEqual({
      agent_id: 'agent-1',
      runtime_profile_id: null,
      execution_device_id: 'device-1',
      model: 'custom-model',
      model_type: null,
      model_options: {},
      workspace_binding: {
        type: 'device_project',
        deviceId: 'device-1',
        runtimeProjectKey: 'project-1',
      },
    })
  })

  it('preserves every explicit V2 execution capability when merging an Issue override', () => {
    const override = {
      agent_id: 'agent-1',
      runtime_profile_id: null,
      execution_device_id: 'cloud-device',
      model: 'moonshot-kimi-k2.7-code-highspeed',
      model_type: 'public' as const,
      model_options: {
        weworkCloudModelNamespace: 'default',
        weworkCloudModelResourceUserId: '0',
      },
      workspace_binding: { type: 'standalone' as const },
      runtime_permission_mode: 'plan' as const,
      execution: { mode: 'git_worktree' as const, baseBranch: 'main' },
      initial_goal: { objective: 'Finish V2', tokenBudget: 2000 },
      initial_supervisor: {
        mode: 'suggest' as const,
        instructions: 'Review architecture',
        modelSelection: {
          modelName: 'moonshot-kimi-k2.7-code-highspeed',
          modelType: 'public' as const,
          options: {},
        },
        intervalSeconds: 30 as const,
      },
      additional_skills: [{ name: 'architecture-review' }],
      attachment_ids: [11],
      attachments: [{ name: 'architecture.png', mimeType: 'image/png', content: 'base64' }],
      project_plugins: [{ id: 'plugin-1', name: 'Plugin One' }],
      additional_context: {
        issue: { kind: 'application' as const, value: 'WEG-1' },
      },
      ephemeral: true,
    }

    expect(mergeWorkflowExecutionConfig(completeConfig, override)).toEqual(override)
  })

  it('merges node overrides with the shared robot configuration', () => {
    expect(
      effectiveWorkflowNodeExecutionConfig(
        { execution_config: completeConfig },
        {
          execution_config_override: true,
          execution_config: {
            agent_id: null,
            runtime_profile_id: null,
            execution_device_id: null,
            model: 'override-model',
            workspace_binding: null,
          },
        }
      )
    ).toEqual({
      ...completeConfig,
      model: 'override-model',
    })
  })

  it('uses one shared snapshot and merges node overrides', () => {
    expect(workflowExecutionConfigComplete(completeConfig)).toBe(true)
    expect(workflowNeedsExecutionConfiguration(workflow())).toBe(false)
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        nodes: [
          {
            ...workflow().nodes[0],
            execution_config: {
              agent_id: null,
              runtime_profile_id: null,
              execution_device_id: null,
              model: 'override-model',
              workspace_binding: null,
            },
            execution_config_override: true,
          },
        ],
      })
    ).toBe(false)
  })

  it('requires configuration for an AI manager with an incomplete Issue snapshot', () => {
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        stage_mode: 'none',
        advancement_policy: 'ai',
        ai_automation_rule_id: 'ai-manager',
        execution_config: {
          agent_id: null,
          runtime_profile_id: 'runtime-1',
          execution_device_id: 'device-1',
          model: null,
          model_type: null,
          model_options: {},
          workspace_binding: { type: 'standalone' },
        },
        nodes: [],
      })
    ).toBe(true)
  })

  it('starts an AI manager only after its Issue snapshot is complete', () => {
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        stage_mode: 'none',
        advancement_policy: 'ai',
        ai_automation_rule_id: 'ai-manager',
        execution_config: completeConfig,
        nodes: [],
      })
    ).toBe(false)
  })

  it('does not request Wework Runtime configuration for a Wegent AI manager', () => {
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        stage_mode: 'none',
        advancement_policy: 'ai',
        ai_automation_rule_id: 'wegent-manager',
        execution_config: null,
        nodes: [],
      })
    ).toBe(false)
  })

  it('requires configuration when neither the workflow nor the node defines it', () => {
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        execution_config: null,
        nodes: [
          {
            ...workflow().nodes[0],
            execution_config: null,
            execution_config_override: true,
          },
        ],
      })
    ).toBe(true)
  })

  it('accepts a complete direct configuration without a robot rule', () => {
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        nodes: [
          {
            ...workflow().nodes[0],
            execution_mode: 'robot',
            automation_rule_id: null,
          },
        ],
      })
    ).toBe(false)
  })

  it('requires configuration for a direct robot stage with no runtime choices', () => {
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        execution_config: null,
        nodes: [
          {
            ...workflow().nodes[0],
            execution_mode: 'robot',
            automation_rule_id: null,
            execution_config: null,
          },
        ],
      })
    ).toBe(true)
  })

  it('checks the destination status when moving an inbox Issue into execution', () => {
    expect(
      itemNeedsExecutionConfiguration(
        {
          status: 'inbox',
          assignee_agent_id: null,
          execution_config: null,
          execution_state: null,
          workflow: {
            ...workflow(),
            execution_config: null,
            nodes: [
              {
                ...workflow().nodes[0],
                execution_mode: 'robot',
                automation_rule_id: null,
                execution_config: null,
              },
            ],
          },
        },
        'in_progress'
      )
    ).toBe(true)
  })

  it('shows a board reminder for an in-progress Issue waiting for configuration', () => {
    const item = {
      id: 'WEG-1',
      title: 'Configure execution',
      description: '',
      status: 'pending',
      priority: 'none',
      tags: [],
      workflow: { ...workflow(), execution_config: null },
    } as unknown as CloudLoopItem

    render(
      <CloudTodoCardContent
        item={item}
        display={{ showAssignee: false, showPriority: false, showTags: false, showDate: false }}
      />
    )

    expect(screen.getByTestId('cloud-todo-card-needs-execution-config-WEG-1')).toHaveTextContent(
      '待配置'
    )
  })

  it('does not use the legacy item config when a workflow snapshot is complete', () => {
    expect(
      itemNeedsExecutionConfiguration({
        status: 'pending',
        assignee_agent_id: 'agent-1',
        execution_config: null,
        execution_state: 'waiting_runtime',
        workflow: workflow(),
      })
    ).toBe(false)
  })

  it('keeps the legacy direct-assignment configuration check without a workflow', () => {
    expect(
      itemNeedsExecutionConfiguration({
        status: 'pending',
        assignee_agent_id: 'agent-1',
        execution_config: null,
        execution_state: 'waiting_runtime',
        workflow: null,
      })
    ).toBe(true)
  })
})
