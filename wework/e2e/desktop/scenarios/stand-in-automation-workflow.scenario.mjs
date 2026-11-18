import assert from 'node:assert/strict'

import {
  assertQualityAdmissionRejected,
  configureDefaultAssistants,
  startOnlineEndpoints,
  waitForAssignmentNotification,
} from '../modules/stand-in-assignment-notifications.mjs'
import {
  AUTOMATION_WORKFLOW_CONTRACT,
  assertQualityReworkState,
  configureWorkflowProject,
  createAutomatedIssue,
  createFixtureUser,
  createTaskCreatedRule,
  createWorkflowProject,
  requestJson,
  requireJson,
  submitDelivery,
  submitQualityReview,
  validateAutomationWorkflowContract,
  waitForStage,
  waitForValue,
  workflowDefinitionFor,
  workflowDiagnostics,
} from '../modules/human-workflow-transition.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

/** P0 contract for W-0069; it remains blocked until W-0068 supplies the runtime reducer. */
const MARKER = `STAND_IN_AUTOMATION_WORKFLOW_${process.pid}`
const REQUIRED_DIAGNOSTIC_FIELDS = AUTOMATION_WORKFLOW_CONTRACT.diagnostics

export function createDesktopScenario({ modelResponseTimeoutMs, uiTimeoutMs }) {
  let backendUrl
  let adminToken
  let environment
  let workspace
  let project
  let rule
  let issue
  let users
  let endpoints = []
  let assistants = []
  let modelRequests = 0

  const api = (path, options, token = adminToken) =>
    requireJson(backendUrl, token, path, { ...options, timeoutMs: uiTimeoutMs })

  async function issueTasks() {
    return api(`/api/v1/loop-items/${issue.id}/tasks`)
  }

  async function assignmentSnapshot() {
    const [current, tasks, assignments] = await Promise.all([
      api(`/api/v1/loop-items/${issue.id}`),
      issueTasks(),
      api(`/api/v1/loop-items/${issue.id}/assignments`),
    ])
    return { current, tasks, assignments: assignments.items ?? assignments }
  }

  function assertWorkflowIdentity(current) {
    const diagnostics = workflowDiagnostics(current, current.__tasks ?? [])
    for (const field of REQUIRED_DIAGNOSTIC_FIELDS) {
      assert.ok(
        Object.hasOwn(diagnostics, field),
        `Runtime diagnostics omitted ${field}: ${JSON.stringify(diagnostics)}`
      )
    }
    assert.ok(
      current.workflow,
      `The automation Issue has no workflow snapshot: ${JSON.stringify(diagnostics)}`
    )
    assert.deepEqual(
      current.workflow.nodes?.map(node => node.id),
      AUTOMATION_WORKFLOW_CONTRACT.stages,
      `The workflow snapshot does not preserve the six-stage contract: ${JSON.stringify(diagnostics)}`
    )
    assert.ok(
      current.workflow.current_stage_id,
      `W-0068 is not implemented: the six-stage snapshot has no server-owned current stage: ${JSON.stringify(diagnostics)}`
    )
    assert.ok(
      current.workflow.strategy_version,
      `The Issue did not bind its strategy version: ${JSON.stringify(diagnostics)}`
    )
    assert.ok(
      current.workflow.compiled_plan_id || current.workflow.instance_id,
      `The server did not expose an internal compiled plan identity: ${JSON.stringify(diagnostics)}`
    )
    return diagnostics
  }

  async function assertWrongStageOwnerRejected() {
    const current = await api(`/api/v1/loop-items/${issue.id}`)
    if (current.workflow?.current_stage_id !== 'requirement_intake') return
    const before = await assignmentSnapshot()
    const result = await requestJson(
      backendUrl,
      users[1].token,
      `/api/v1/loop-items/${issue.id}/deliveries`,
      {
        body: {
          title: `${MARKER} wrong owner`,
          markdown: 'The wrong stage owner must not advance.',
        },
        timeoutMs: uiTimeoutMs,
      }
    )
    assert.equal(result.ok, false, 'The wrong stage owner submitted a delivery')
    assert.ok([403, 409].includes(result.status), `Unexpected wrong-owner status ${result.status}`)
    const after = await assignmentSnapshot()
    assert.equal(after.current.workflow.current_stage_id, 'requirement_intake')
    assert.equal(after.current.assignee_user_id, before.current.assignee_user_id)
    assert.equal(after.tasks.length, before.tasks.length)
    assert.equal(after.assignments.length, before.assignments.length)
  }

  async function assertDuplicateDeliveryIsIdempotent() {
    const current = await api(`/api/v1/loop-items/${issue.id}`)
    if (current.workflow?.current_stage_id !== 'requirement_intake') return
    const node = current.workflow.nodes.find(value => value.id === 'requirement_intake')
    const delivered = await submitDelivery({
      baseUrl: backendUrl,
      token: users[0].token,
      issueId: issue.id,
      title: `${MARKER} requirements`,
      markdown: 'Requirements, scope, and acceptance evidence.',
      fulfillments: node.required_deliverables.map(requirement => ({
        requirement_id: requirement.id,
        kind: 'text',
        text: `${MARKER} verified ${requirement.name}`,
      })),
    })
    assert.equal(delivered.status, 'delivered')
    const tasksBefore = await issueTasks()
    const assignmentsBefore = (await api(`/api/v1/loop-items/${issue.id}/assignments`)).items ?? []
    const review = await waitForStage({
      baseUrl: backendUrl,
      token: adminToken,
      issueId: issue.id,
      expected: 'joint_review',
      timeoutMs: modelResponseTimeoutMs * 2,
    })
    assert.equal(review.workflow.current_stage_id, 'joint_review')
    assert.equal((await issueTasks()).length, tasksBefore.length)
    assert.deepEqual(
      (await api(`/api/v1/loop-items/${issue.id}/assignments`)).items ?? [],
      assignmentsBefore
    )
  }

  async function assertPrivateProcessesStayPrivate() {
    const comments = await waitForValue({
      load: () =>
        api(
          `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`,
          undefined,
          users[0].token
        ),
      accept: rows => (rows.some(comment => comment.stand_in_reply_to) ? rows : null),
      label: 'No attributed assistant summary reached the shared timeline',
      timeoutMs: modelResponseTimeoutMs,
    })
    const shared = JSON.stringify(comments)
    assert.doesNotMatch(shared, /PRIVATE_.*_PROCESS/u)
    assert.doesNotMatch(shared, /compiled_plan|internal_plan|manager_plan/iu)
    assert.doesNotMatch(shared, /tool_calls|stdout|stderr|chain_of_thought/iu)
    assert.match(shared, /summary|摘要|delivery|交付/iu)
    const generated = comments.filter(comment => comment.stand_in_reply_to)
    assert.ok(generated.length > 0, 'No attributed default-assistant summary reached the timeline')
    assert.ok(
      generated.every(
        comment =>
          comment.stand_in_reply_to.role_id &&
          comment.stand_in_reply_to.role_name &&
          comment.stand_in_reply_to.device_id
      ),
      'Generated shared summaries must retain the assistant and device identity'
    )
  }

  return {
    requiresCloudEnvironment: true,
    backendEnv: {
      HUMAN_ASSIGNMENT_RECEIPTS_ENABLED: 'true',
      HUMAN_AUTOMATION_RECEIPTS_ENABLED: 'true',
    },

    async prepareCloud(cloud) {
      validateAutomationWorkflowContract()
      backendUrl = cloud.backendUrl
      adminToken = cloud.authToken
      await api('/api/admin/setup-complete', { body: {} })
      const userA = await api('/api/users/me')
      users = [
        { user: userA, token: adminToken, user_name: userA.user_name },
        await createFixtureUser({ baseUrl: backendUrl, adminToken, name: 'w0069-user-b' }),
        await createFixtureUser({ baseUrl: backendUrl, adminToken, name: 'w0069-design' }),
        await createFixtureUser({ baseUrl: backendUrl, adminToken, name: 'w0069-engineering' }),
        await createFixtureUser({ baseUrl: backendUrl, adminToken, name: 'w0069-pmo' }),
      ]
      const fixture = await createWorkflowProject({
        baseUrl: backendUrl,
        ownerToken: adminToken,
        members: users.slice(1),
        label: MARKER,
      })
      workspace = fixture.workspace
      project = await configureWorkflowProject({
        baseUrl: backendUrl,
        token: adminToken,
        project: fixture.project,
        definition: workflowDefinitionFor({
          userAId: users[0].user.id,
          userBId: users[1].user.id,
          designId: users[2].user.id,
          engineeringId: users[1].user.id,
          pmoId: users[4].user.id,
        }),
      })
      rule = await createTaskCreatedRule({
        baseUrl: backendUrl,
        token: adminToken,
        projectId: project.id,
        targetUserId: users[0].user.id,
        marker: MARKER,
      })
    },

    setCloudEnvironment(value) {
      environment = value
    },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(MARKER)) return false
      modelRequests += 1
      const id = `${MARKER}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(`${MARKER} stage evidence recorded.`),
          responseCompleted(id),
        ])
      )
      return true
    },

    async verify(control) {
      try {
        await environment.waitForConnectedAppDevice()
        endpoints = await startOnlineEndpoints({
          environment,
          users: users.slice(0, 2),
          processId: process.pid,
        })
        assistants = await configureDefaultAssistants({
          control,
          baseUrl: backendUrl,
          projectId: project.id,
          users: users.slice(0, 2),
          marker: MARKER,
          uiTimeoutMs,
        })
        assert.equal(new Set(assistants.map(value => value.roleId)).size, 2)
        assert.equal(new Set(endpoints.map(value => value.userId)).size, 2)

        issue = await createAutomatedIssue({
          baseUrl: backendUrl,
          token: adminToken,
          projectId: project.id,
          ruleId: rule.id,
          marker: MARKER,
        })
        await assertQualityAdmissionRejected({ baseUrl: backendUrl, token: adminToken, issue })
        await waitForAssignmentNotification({
          baseUrl: backendUrl,
          token: adminToken,
          issueId: issue.id,
          timeoutMs: modelResponseTimeoutMs,
        })
        const assigned = await waitForValue({
          load: () => api(`/api/v1/loop-items/${issue.id}`),
          accept: current =>
            current.assignee_user_id === users[0].user.id && current.human_task_binding
              ? current
              : null,
          label: 'task.created did not assign the Issue to user A',
          timeoutMs: modelResponseTimeoutMs,
        })
        assigned.__tasks = await issueTasks()
        assert.equal(assigned.__tasks.length, 1, 'task.created created duplicate runtime tasks')
        assertWorkflowIdentity(assigned)
        await assertWrongStageOwnerRejected()
        await assertDuplicateDeliveryIsIdempotent()

        const quality = await waitForStage({
          baseUrl: backendUrl,
          token: adminToken,
          issueId: issue.id,
          expected: 'quality_acceptance',
          timeoutMs: modelResponseTimeoutMs * 4,
        })
        assert.equal(quality.assignee_user_id, users[1].user.id)
        const qualityTasks = await issueTasks()
        assert.equal(qualityTasks.length >= 2, true)
        assert.equal(
          quality.workflow.current_stage_id,
          AUTOMATION_WORKFLOW_CONTRACT.qualityRework.stage
        )
        const headSha = process.env.WEWORK_E2E_PR_HEAD_SHA || process.env.GITHUB_SHA
        assert.ok(headSha, 'The quality gate requires the current PR head SHA')
        await submitQualityReview({
          baseUrl: backendUrl,
          token: users[1].token,
          issue: quality,
          decision: 'changes_requested',
          evidence: [`${MARKER} regression failed on ${headSha}`],
          headSha,
          idempotencyKey: `${MARKER}-quality-rework-1`,
        })
        const reworked = await waitForValue({
          load: () => api(`/api/v1/loop-items/${issue.id}`),
          accept: current => {
            try {
              assertQualityReworkState(current)
              return current
            } catch {
              return null
            }
          },
          label: 'needs_rework did not preserve quality acceptance and return to engineering',
          timeoutMs: modelResponseTimeoutMs * 2,
        })
        assert.equal(reworked.status, 'in_review')
        assert.equal(reworked.completed_at, null)
        await submitQualityReview({
          baseUrl: backendUrl,
          token: users[1].token,
          issue: reworked,
          decision: 'no_objection',
          evidence: [`${MARKER} repaired evidence for ${headSha}`],
          headSha,
          idempotencyKey: `${MARKER}-quality-rework-2`,
        })
        const accepted = await waitForValue({
          load: () => api(`/api/v1/loop-items/${issue.id}`),
          accept: current =>
            current.status === 'in_review' &&
            (current.quality_handoff?.quality_blocked ?? current.workflow?.quality_blocked) ===
              false
              ? current
              : null,
          label: 'The repaired quality acceptance did not settle in review',
          timeoutMs: modelResponseTimeoutMs * 2,
        })
        await assertPrivateProcessesStayPrivate()
        assert.equal(accepted.status, 'in_review')
        assert.equal(accepted.completed_at, null, 'Automatic work must not complete the Issue')
        this.verifiedDiagnostics = workflowDiagnostics(accepted, qualityTasks)
        assert.equal(modelRequests > 0, true)
      } finally {
        await Promise.allSettled(endpoints.map(endpoint => endpoint.stop()))
        if (issue) {
          await api(`/api/v1/loop-items/${issue.id}`, { method: 'DELETE' }).catch(() => null)
        }
        if (project) {
          const current = await api(`/api/v1/cloud-projects/${project.id}`).catch(() => null)
          if (current) {
            await api(`/api/v1/cloud-projects/${project.id}?version=${current.version}`, {
              method: 'DELETE',
            }).catch(() => null)
          }
        }
        if (workspace) {
          const current = await api(`/api/v1/workspaces/${workspace.id}`).catch(() => null)
          if (current) {
            await api(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, {
              method: 'DELETE',
            }).catch(() => null)
          }
        }
      }
    },

    diagnostics() {
      return {
        issueId: issue?.id,
        projectId: project?.id,
        strategyVersion: this.verifiedDiagnostics?.strategyVersion ?? null,
        compiledPlanId: this.verifiedDiagnostics?.compiledPlanId ?? null,
        endpoints: endpoints.map(endpoint => ({
          userId: endpoint.userId,
          deviceId: endpoint.deviceId,
        })),
        assistants: assistants.map(value => ({ userId: value.userId, roleId: value.roleId })),
        modelRequests,
        workflow: this.verifiedDiagnostics ?? null,
      }
    },
  }
}
