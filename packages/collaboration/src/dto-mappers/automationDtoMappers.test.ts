import { describe, expect, it } from 'vitest'
import {
  mapAutomationBackendRunDto,
  mapHumanTargetAutomationRunReceiptDto,
} from './automationDtoMappers'

const receipt = {
  automation_run_id: 'run-1',
  assignment_id: 'assignment-1',
  human_assignment_id: 'human-1',
  workflow_stage_id: 'ux_spec',
  required_deliverables: [
    {
      id: 'ux_spec_file',
      name: 'Design specification',
      description: 'Submit the design',
      value_type: 'file',
      file_constraints: { accepted_types: ['application/pdf'], min_files: 1, max_files: 2 },
    },
  ],
  non_workflow: false,
  idempotency_key: 'run-1:human-1',
  owner_user_id: 7,
  state: 'waiting_device',
  reason_code: 'waiting_device',
  runtime_task_id: 'runtime-1',
  runtime_device_id: 'device-1',
  endpoint_ref: 'wework-local:device-1:@primary',
  delivery_id: null,
  execution_id: 'execution-1',
}

describe('human automation run DTO mapping', () => {
  it('retains the stage, complete required definitions and stable execution references', () => {
    expect(mapHumanTargetAutomationRunReceiptDto(receipt)).toEqual({
      automationRunId: 'run-1',
      assignmentId: 'assignment-1',
      humanAssignmentId: 'human-1',
      workflowStageId: 'ux_spec',
      requiredDeliverables: receipt.required_deliverables,
      nonWorkflow: false,
      idempotencyKey: 'run-1:human-1',
      ownerUserId: 7,
      state: 'waiting_device',
      reasonCode: 'waiting_device',
      runtimeTaskId: 'runtime-1',
      runtimeDeviceId: 'device-1',
      endpointRef: receipt.endpoint_ref,
      deliveryId: null,
      executionId: 'execution-1',
    })
  })

  it('accepts already mapped receipts and does not retain private extensions', () => {
    const mapped = mapHumanTargetAutomationRunReceiptDto(receipt)
    expect(
      mapHumanTargetAutomationRunReceiptDto({ ...mapped, privateTranscript: 'private' })
    ).toEqual(mapped)
    expect(
      mapHumanTargetAutomationRunReceiptDto({ ...receipt, private_prompt: 'private' })
    ).toEqual(mapped)
  })

  it('preserves null stage identity for ordinary human targets', () => {
    expect(
      mapHumanTargetAutomationRunReceiptDto({
        ...receipt,
        workflow_stage_id: null,
        required_deliverables: [],
        non_workflow: true,
      })
    ).toMatchObject({ workflowStageId: null, requiredDeliverables: [], nonWorkflow: true })
  })

  it('keeps legacy runs unchanged when no receipt is provided', () => {
    const run = { id: 'run-1', status: 'succeeded' }
    expect(mapAutomationBackendRunDto(run)).toEqual(run)
  })

  it('normalizes the receipt without exposing its snake-case transport field', () => {
    const mapped = mapAutomationBackendRunDto({
      id: 'run-1',
      status: 'waiting_device',
      humanAutomation: receipt,
    })
    expect(mapped.humanAutomation?.runtimeTaskId).toBe('runtime-1')
    expect(mapped).not.toHaveProperty('human_automation')
    expect(mapAutomationBackendRunDto({ id: 'run-1', human_automation: receipt })).toMatchObject({
      humanAutomation: mapped.humanAutomation,
    })
  })

  it('does not attach a receipt to another automation run or fabricate an incomplete identity', () => {
    expect(
      mapAutomationBackendRunDto({ id: 'run-2', human_automation: receipt }).humanAutomation
    ).toBeNull()
    expect(mapHumanTargetAutomationRunReceiptDto({ state: 'succeeded' })).toBeNull()
  })
})
