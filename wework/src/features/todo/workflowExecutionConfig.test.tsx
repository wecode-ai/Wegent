import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, IssueWorkflowInstance } from '@/api/deliveries'
import { CloudTodoCardContent } from './CloudTodoBoardCard'
import {
  workflowExecutionConfigComplete,
  workflowNeedsExecutionConfiguration,
} from './workflowExecutionConfig'

const completeConfig = {
  agent_id: 'agent-1',
  runtime_profile_id: 'runtime-1',
  model: 'model-1',
  workspace_binding: { type: 'backend_project' as const, projectId: 9 },
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
  it('uses one shared snapshot unless a node overrides it', () => {
    expect(workflowExecutionConfigComplete(completeConfig)).toBe(true)
    expect(workflowNeedsExecutionConfiguration(workflow())).toBe(false)
    expect(
      workflowNeedsExecutionConfiguration({
        ...workflow(),
        nodes: [
          {
            ...workflow().nodes[0],
            execution_config: { ...completeConfig, model: null },
            execution_config_override: true,
          },
        ],
      })
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
})
