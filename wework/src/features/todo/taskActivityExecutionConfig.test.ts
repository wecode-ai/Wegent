import { describe, expect, it } from 'vitest'
import type { CloudLoopItem, WorkflowExecutionConfig } from '@/api/deliveries'
import { activityTaskRequest, taskActivityExecutionConfig } from './taskActivityExecutionConfig'
import { emptyWorkflowExecutionConfig } from './workflowExecutionConfig'

const config: WorkflowExecutionConfig = {
  ...emptyWorkflowExecutionConfig(),
  model: 'configured-model',
  model_type: 'runtime',
  model_options: { reasoningEffort: 'high' },
  execution_device_id: 'original-device',
  workspace_binding: {
    type: 'device_project',
    deviceId: 'original-device',
    runtimeProjectKey: 'project-key',
  },
}

describe('activity execution configuration', () => {
  it('uses the current stage override for a new task', () => {
    const issue = {
      execution_config: config,
      workflow: {
        execution_config: config,
        current_stage_id: 'review',
        nodes: [
          { id: 'build', execution_config: { ...config, model: 'build-model' } },
          {
            id: 'review',
            execution_config_override: true,
            execution_config: { ...config, model: 'review-model' },
          },
        ],
      },
    } as unknown as CloudLoopItem
    expect(taskActivityExecutionConfig(issue)?.model).toBe('review-model')
  })

  it('retains the workflow configuration after its final stage completes', () => {
    const issue = {
      status: 'completed',
      workflow: {
        execution_config: config,
        current_stage_id: null,
        nodes: [],
        orchestration_status: 'completed',
      },
    } as unknown as CloudLoopItem
    const request = activityTaskRequest(taskActivityExecutionConfig(issue), 'new task')
    expect(request).toMatchObject({
      message: 'new task',
      modelId: 'configured-model',
      deviceId: 'original-device',
      runtimeProjectKey: 'project-key',
      ephemeral: false,
    })
    expect(request).not.toHaveProperty('workflowNodeId')
  })

  it('carries execution controls and attachments into the runtime request', () => {
    expect(
      activityTaskRequest(
        {
          ...config,
          runtime_permission_mode: 'full-access',
          attachment_ids: [5],
          additional_context: { note: { kind: 'application', value: 'context' } },
        },
        'start'
      )
    ).toMatchObject({
      runtimePermissionMode: 'full-access',
      attachmentIds: [5],
      additionalContext: { note: { value: 'context' } },
    })
  })
})
