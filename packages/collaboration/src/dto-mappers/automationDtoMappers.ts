import type {
  AutomationBackendRun,
  HumanTargetAutomationRunReceipt,
  WorkflowDeliverableRequirement,
} from '../automation/types'

function record(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

function field(row: Record<string, unknown>, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake]
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function requirement(input: unknown): WorkflowDeliverableRequirement | null {
  const row = record(input)
  const id = nullableString(row.id)
  const valueType = field(row, 'valueType', 'value_type')
  if (
    !id ||
    typeof valueType !== 'string' ||
    !['text', 'file', 'code_snapshot', 'git_branch', 'pull_request', 'url'].includes(valueType)
  )
    return null
  const constraints = record(field(row, 'fileConstraints', 'file_constraints'))
  return {
    id,
    name: nullableString(row.name) ?? id,
    description: nullableString(row.description) ?? '',
    value_type: valueType as WorkflowDeliverableRequirement['value_type'],
    ...(Object.keys(constraints).length
      ? {
          file_constraints: {
            accepted_types:
              (field(constraints, 'acceptedTypes', 'accepted_types') as string[]) ?? [],
            min_files: Number(field(constraints, 'minFiles', 'min_files') ?? 1),
            max_files: Number(field(constraints, 'maxFiles', 'max_files') ?? 1),
          },
        }
      : {}),
  }
}

export function mapHumanTargetAutomationRunReceiptDto(
  input: unknown
): HumanTargetAutomationRunReceipt | null {
  const row = record(input)
  const automationRunId = nullableString(field(row, 'automationRunId', 'automation_run_id'))
  const assignmentId = nullableString(field(row, 'assignmentId', 'assignment_id'))
  const humanAssignmentId = nullableString(field(row, 'humanAssignmentId', 'human_assignment_id'))
  const idempotencyKey = nullableString(field(row, 'idempotencyKey', 'idempotency_key'))
  const ownerUserId = Number(field(row, 'ownerUserId', 'owner_user_id'))
  if (
    !automationRunId ||
    !assignmentId ||
    !humanAssignmentId ||
    !idempotencyKey ||
    !Number.isFinite(ownerUserId)
  )
    return null
  const requirements = field(row, 'requiredDeliverables', 'required_deliverables')
  return {
    automationRunId,
    assignmentId,
    humanAssignmentId,
    workflowStageId: nullableString(field(row, 'workflowStageId', 'workflow_stage_id')),
    requiredDeliverables: Array.isArray(requirements)
      ? requirements
          .map(requirement)
          .filter((value): value is WorkflowDeliverableRequirement => value !== null)
      : [],
    nonWorkflow: field(row, 'nonWorkflow', 'non_workflow') === true,
    idempotencyKey,
    ownerUserId,
    state: nullableString(row.state) as HumanTargetAutomationRunReceipt['state'],
    reasonCode: nullableString(field(row, 'reasonCode', 'reason_code')),
    runtimeTaskId: nullableString(field(row, 'runtimeTaskId', 'runtime_task_id')),
    runtimeDeviceId: nullableString(field(row, 'runtimeDeviceId', 'runtime_device_id')),
    endpointRef: nullableString(field(row, 'endpointRef', 'endpoint_ref')),
    deliveryId: nullableString(field(row, 'deliveryId', 'delivery_id')),
    executionId: nullableString(field(row, 'executionId', 'execution_id')),
  }
}

export function mapAutomationBackendRunDto(
  input: unknown
): AutomationBackendRun & Record<string, unknown> {
  const row = record(input)
  const { human_automation, humanAutomation, ...run } = row
  const receipt = mapHumanTargetAutomationRunReceiptDto(humanAutomation ?? human_automation)
  return {
    ...(run as unknown as AutomationBackendRun),
    ...(humanAutomation === undefined && human_automation === undefined
      ? {}
      : { humanAutomation: receipt?.automationRunId === run.id ? receipt : null }),
  }
}
