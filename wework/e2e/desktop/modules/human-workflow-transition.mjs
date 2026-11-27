import assert from 'node:assert/strict'

export const AUTOMATION_WORKFLOW_CONTRACT = Object.freeze({
  featureFlag: 'e2e.collaboration.automationWorkflow.v1',
  stages: [
    'requirement_intake',
    'joint_review',
    'development_preparation',
    'development_implementation',
    'quality_acceptance',
    'release_launch',
  ],
  requiredReviewRoles: ['design', 'engineering', 'qa'],
  diagnostics: [
    'issueId',
    'strategyVersion',
    'compiledPlanId',
    'stageId',
    'assignmentId',
    'runtimeTaskId',
    'deliveryId',
    'lastEventSequence',
    'attempt',
  ],
  qualityRework: Object.freeze({
    stage: 'quality_acceptance',
    ownerRole: 'engineering',
    blockedFlag: 'quality_blocked',
    downstreamBlocked: true,
    retainsFailureEvidence: true,
    retainsAttempt: true,
    returnsToQaOnlyAfterAdmission: true,
  }),
  finalization: Object.freeze({
    releaseRequiresAllRequiredPullRequestsMerged: true,
    authorizedConfirmationPrecedesInReview: true,
    completionRequiresSuccessfulReleaseVersion: true,
  }),
})

export function validateAutomationWorkflowContract(contract = AUTOMATION_WORKFLOW_CONTRACT) {
  assert.equal(contract.featureFlag, 'e2e.collaboration.automationWorkflow.v1')
  assert.deepEqual(contract.stages, [
    'requirement_intake',
    'joint_review',
    'development_preparation',
    'development_implementation',
    'quality_acceptance',
    'release_launch',
  ])
  assert.deepEqual(contract.requiredReviewRoles, ['design', 'engineering', 'qa'])
  assert.ok(contract.qualityRework.downstreamBlocked)
  assert.ok(contract.qualityRework.retainsAttempt)
  assert.ok(contract.qualityRework.returnsToQaOnlyAfterAdmission)
  assert.ok(contract.finalization.releaseRequiresAllRequiredPullRequestsMerged)
  assert.ok(contract.finalization.authorizedConfirmationPrecedesInReview)
  return contract
}

export function workflowDefinitionFor({ userAId, userBId, designId, engineeringId, pmoId }) {
  const text = (id, name) => ({ id, name, value_type: 'text' })
  const stage = (id, name, dependsOn, assigneeId, role, deliverables) => ({
    id,
    name,
    node_type: 'task',
    execution_mode: 'human',
    depends_on: dependsOn,
    dependency_context: Object.fromEntries(
      dependsOn.map(dependency => [dependency, ['final_result', 'deliveries']])
    ),
    required: true,
    workspace_policy: 'none',
    required_assignee_type: 'user',
    required_assignee_id: String(assigneeId),
    required_assignee_role: role,
    required_deliverables: deliverables,
  })
  return {
    version: 1,
    stage_mode: 'dag',
    advancement_policy: 'manual',
    approval_policy: 'required',
    assignee_roles: {
      product: [{ assignee_type: 'user', assignee_id: String(userAId) }],
      design: [{ assignee_type: 'user', assignee_id: String(designId) }],
      engineering: [{ assignee_type: 'user', assignee_id: String(engineeringId) }],
      qa: [{ assignee_type: 'user', assignee_id: String(userBId) }],
      pmo: [{ assignee_type: 'user', assignee_id: String(pmoId) }],
    },
    nodes: [
      stage('requirement_intake', '需求提出', [], userAId, 'product', [
        text('objective', '目标'),
        text('scope', '范围'),
        text('acceptance', '验收标准'),
      ]),
      stage('joint_review', '共同评审', ['requirement_intake'], userAId, 'product', [
        text('design_review', 'UI 评审'),
        text('engineering_review', '研发评审'),
        text('qa_review', '测试评审'),
      ]),
      stage('development_preparation', '开发准备', ['joint_review'], userAId, 'product', [
        text('design_delivery', '设计交付'),
        text('technical_plan', '技术方案'),
        text('test_plan', '测试方案'),
      ]),
      stage(
        'development_implementation',
        '开发实现',
        ['development_preparation'],
        userBId,
        'engineering',
        [
          text('implementation', '实现说明'),
          text('self_test', '自测结果'),
          {
            id: 'pull_request',
            name: '关联 PR',
            value_type: 'pull_request',
          },
        ]
      ),
      stage('quality_acceptance', '质量验收', ['development_implementation'], userBId, 'qa', [
        text('qa_report', '测试报告'),
        text('business_acceptance', '产品验收'),
        text('visual_acceptance', '视觉验收'),
      ]),
      stage('release_launch', '发布上线', ['quality_acceptance'], userAId, 'product', [
        text('release_record', '发布记录'),
        text('post_release_verification', '发布后验证'),
      ]),
    ],
  }
}

export async function requestJson(baseUrl, token, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  })
  const responseText = await response.text()
  let data = null
  if (responseText) {
    try {
      data = JSON.parse(responseText)
    } catch {
      data = responseText
    }
  }
  return { ok: response.ok, status: response.status, data }
}

export async function requireJson(baseUrl, token, path, options) {
  const result = await requestJson(baseUrl, token, path, options)
  assert.ok(
    result.ok,
    `${options?.method ?? 'GET'} ${path}: ${result.status} ${JSON.stringify(result.data)}`
  )
  return result.data
}

export async function createFixtureUser({ baseUrl, adminToken, name }) {
  const user_name = `${name}-${process.pid}`
  const password = `${name}-e2e-${process.pid}`
  const user = await requireJson(baseUrl, adminToken, '/api/admin/users', {
    body: { user_name, password, role: 'user', auth_source: 'password' },
  })
  const login = await requireJson(baseUrl, null, '/api/auth/login', {
    body: { user_name, password },
  })
  assert.ok(login.access_token, `Fixture user ${user_name} received no access token`)
  return { user, token: login.access_token, user_name }
}

export async function createWorkflowProject({ baseUrl, ownerToken, members, label }) {
  const workspace = await requireJson(baseUrl, ownerToken, '/api/v1/workspaces', {
    body: { name: `${label} workspace` },
  })
  let project = await requireJson(baseUrl, ownerToken, '/api/v1/cloud-projects', {
    body: { workspace_id: workspace.id, name: `${label} project`, task_provider: 'local' },
  })
  for (const member of members) {
    await requireJson(baseUrl, ownerToken, `/api/v1/cloud-projects/${project.id}/members`, {
      body: { user_id: member.user.id, role: 'Developer' },
    })
  }
  project = await requireJson(baseUrl, ownerToken, `/api/v1/cloud-projects/${project.id}`)
  return { workspace, project }
}

export async function configureWorkflowProject({ baseUrl, token, project, definition }) {
  const current = await requireJson(baseUrl, token, `/api/v1/cloud-projects/${project.id}`)
  return requireJson(baseUrl, token, `/api/v1/cloud-projects/${project.id}`, {
    method: 'PATCH',
    body: { version: current.version, workflow_definition: definition },
  })
}

export async function createTaskCreatedRule({ baseUrl, token, projectId, targetUserId, marker }) {
  return requireJson(baseUrl, token, `/api/v1/cloud-projects/${projectId}/automations`, {
    body: {
      name: `${marker} task.created`,
      prompt: 'Admit the Issue and start the first server-owned workflow stage.',
      trigger_type: 'event',
      event_type: 'task.created',
      event_config: { execution_target: 'existing_issue' },
      target_kind: 'human',
      target_id: String(targetUserId),
      enabled: true,
    },
  })
}

export async function createAutomatedIssue({ baseUrl, token, projectId, ruleId, marker }) {
  return requireJson(baseUrl, token, `/api/v1/cloud-projects/${projectId}/loop-items`, {
    body: {
      title: `${marker} two-user automation`,
      description: 'Exercise the six-stage policy through server events only.',
      priority: 'urgent',
      tags: [marker],
      automation_rule_id: String(ruleId),
    },
  })
}

export async function waitForValue({ load, accept, label, timeoutMs, pollMs = 200 }) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await load()
    if (accept(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  assert.fail(`${label}: ${JSON.stringify(latest)}`)
}

export async function waitForStage({ baseUrl, token, issueId, expected, timeoutMs }) {
  return waitForValue({
    load: () => requireJson(baseUrl, token, `/api/v1/loop-items/${issueId}`),
    accept: issue => issue.workflow?.current_stage_id === expected,
    label: `Issue ${issueId} did not reach workflow stage ${expected}`,
    timeoutMs,
  })
}

export function workflowDiagnostics(issue, tasks = []) {
  const stage = issue.workflow?.nodes?.find(node => node.id === issue.workflow?.current_stage_id)
  return {
    issueId: issue.id,
    strategyVersion: issue.workflow?.strategy_version ?? issue.workflow?.definition_version ?? null,
    compiledPlanId: issue.workflow?.compiled_plan_id ?? issue.workflow?.instance_id ?? null,
    stageId: issue.workflow?.current_stage_id ?? null,
    assignmentId:
      issue.human_task_binding?.assignmentId ??
      issue.assignment_history?.at(-1)?.assignment_id ??
      null,
    runtimeTaskId: tasks.at(-1)?.task_id ?? null,
    deliveryId: stage?.delivery_ids?.at(-1) ?? issue.current_delivery_id ?? null,
    lastEventSequence: issue.activity_sequence ?? null,
    attempt: stage?.attempts ?? 0,
    status: issue.status,
    qualityBlocked:
      issue.quality_handoff?.quality_blocked ?? issue.workflow?.quality_blocked ?? false,
  }
}

export async function submitDelivery({ baseUrl, token, issueId, title, markdown, fulfillments }) {
  const draft = await requireJson(baseUrl, token, `/api/v1/loop-items/${issueId}/deliveries`, {
    body: { title, markdown },
  })
  const repeated = await requireJson(baseUrl, token, `/api/v1/loop-items/${issueId}/deliveries`, {
    body: { title, markdown },
  })
  assert.equal(repeated.id, draft.id, 'A duplicate delivery create created a second draft')
  return requireJson(baseUrl, token, `/api/v1/deliveries/${draft.id}/finalize`, {
    body: { fulfillments },
  })
}

export async function submitQualityReview({
  baseUrl,
  token,
  issue,
  decision,
  evidence,
  headSha,
  idempotencyKey,
}) {
  return requireJson(baseUrl, token, `/api/v1/loop-items/${issue.id}`, {
    method: 'PATCH',
    body: {
      version: issue.version,
      quality_review: {
        decision,
        evidence,
        idempotency_key: idempotencyKey,
        pr_head_sha: headSha,
      },
    },
  })
}

export function assertQualityReworkState(issue) {
  const quality = issue.workflow?.nodes?.find(
    node => node.id === AUTOMATION_WORKFLOW_CONTRACT.qualityRework.stage
  )
  assert.ok(quality, 'The quality acceptance node is unavailable')
  assert.equal(issue.workflow.current_stage_id, AUTOMATION_WORKFLOW_CONTRACT.qualityRework.stage)
  assert.equal(issue.quality_handoff?.quality_blocked ?? issue.workflow?.quality_blocked, true)
  assert.ok(quality.attempts >= 2, 'needs_rework did not retain a new attempt')
  assert.ok(quality.delivery_ids?.length >= 2, 'needs_rework discarded failed evidence')
  assert.ok(
    issue.workflow.nodes
      .filter(node => node.id === 'release_launch')
      .every(node => node.status === 'blocked'),
    'needs_rework left a downstream node unblocked'
  )
  return quality
}
