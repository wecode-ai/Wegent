import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'
import { storyUntil } from './stand-in-source-story-evidence.mjs'
import { standInRoleFixture } from './stand-in-role-fixture.mjs'

const MARKER = 'E2E_PARTICIPATING_ISSUE_SCOPE'
const ROLE = 'participating-issue-scope'

export function createParticipatingIssuesStory({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let modelTurns = 0
  return {
    async handleHttp(req, res, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (
        JSON.stringify(body).includes(MARKER) &&
        !['prewarm', 'compaction'].includes(codexRequestKind(body))
      )
        modelTurns++
      const id = `participating-issues-${modelTurns}`
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      res.end(createSse([responseCreated(id), assistantMessage(MARKER), responseCompleted(id)]))
      return true
    },
    async verify(control, cloud) {
      async function request(path, method = 'GET', body) {
        const response = await fetch(`${cloud.backendUrl}/api${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(uiTimeoutMs),
        })
        const text = await response.text()
        assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
        return text ? JSON.parse(text) : null
      }
      const rpc = (method, args) => requestExecutor(control, method, args, uiTimeoutMs)
      const user = await request('/users/me')
      const workspace = await request('/v1/workspaces', 'POST', { name: MARKER })
      const project = await request('/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: MARKER,
        task_provider: 'local',
      })
      const issuePath = `/v1/cloud-projects/${project.id}/loop-items`
      const createIssue = title =>
        request(issuePath, 'POST', {
          title,
          tags: ['participation-scope'],
          notify_assignee: false,
        })
      const [member, outsider, overlapping, assigned] = await Promise.all(
        ['participant only', 'outside both scopes', 'overlapping scopes', 'assigned'].map(label =>
          createIssue(`${MARKER} ${label}`)
        )
      )
      let settings = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      const originalPrimary = settings.primary
      const catalog = await rpc('runtime.runner.catalog', {})
      const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
      assert.ok(model, 'Use the configured native E2E model')
      const save = async (role, projects) => {
        settings = await rpc('runtime.stand_in.personal.save', {
          userId: user.id,
          settings: {
            ...settings,
            primary: {
              ...settings.primary,
              enabled: true,
              prompt: settings.primary?.prompt ?? '',
              preferences: settings.primary?.preferences ?? '',
            },
            roles: [
              ...settings.roles.filter(existing => existing.id !== ROLE),
              {
                ...role,
                collaboration: { ...role.collaboration, projects },
              },
            ],
          },
        })
        const saved = settings.roles.find(existing => existing.id === ROLE)
        assert.equal(saved?.collaboration.includeParticipatingIssues, true)
        return saved
      }
      const role = await save(
        {
          ...standInRoleFixture(settings.executionDeviceId, ROLE),
          name: ROLE,
          enabled: true,
          model,
          prompt: MARKER,
          handlingPolicy: { automatic: true, askBeforeAct: false, immediate: true },
          collaboration: {
            enabled: true,
            allProjects: false,
            includeParticipatingIssues: true,
            excludedProjects: [],
            tags: ['participation-scope'],
          },
        },
        []
      )

      const tasks = issue => request(`/v1/loop-items/${issue.id}/tasks`)
      for (const issue of [member, outsider, overlapping, assigned]) {
        await request(`/v1/loop-items/${issue.id}/collaborators`, 'POST', { user_id: user.id })
      }
      assert.deepEqual(await tasks(member), [], 'Adding a participant must not start a task')
      const comment = (issue, body, mentions = []) =>
        request(`${issuePath}/${issue.id}/activity-comments`, 'POST', { body, mentions })
      await comment(member, 'An ordinary comment in my participating Issue')
      assert.deepEqual(await tasks(member), [], 'An ordinary comment must not start a task')
      const mention = async issue => {
        const posted = await comment(issue, `${MARKER} please handle this Issue`, [
          { type: 'user', id: String(user.id), label: user.user_name },
        ])
        return {
          projectId: String(project.id),
          itemId: issue.id,
          commentId: posted.id,
          recipientUserId: user.id,
        }
      }
      const waitForProcessed = async issue => {
        const [binding] = await storyUntil(
          () => tasks(issue),
          rows => rows.length === 1 && rows[0].stand_in_pending === false,
          modelResponseTimeoutMs,
          `Assistant must create one binding for ${issue.id}`
        )
        await storyUntil(
          () => rpc('runtime.tasks.get', { taskId: binding.task_id }),
          value => {
            assert.notEqual(
              value.task?.status,
              'failed',
              JSON.stringify(value.task?.runtimeHandle?.startupFailure)
            )
            return value.task?.status === 'done'
          },
          modelResponseTimeoutMs,
          `Assistant task for ${issue.id} must finish`
        )
      }

      await request(`/v1/loop-items/${outsider.id}/collaborators/${user.id}`, 'DELETE')
      await rpc('runtime.stand_in.assignment', await mention(outsider))
      assert.deepEqual(await tasks(outsider), [], 'An issue outside both scopes must be ignored')
      await rpc('runtime.stand_in.assignment', await mention(member))
      await waitForProcessed(member)
      assert.equal(modelTurns, 1, 'A mention in a participating Issue must run once')

      await save(role, [{ id: String(project.id), store: 'cloud' }])
      const event = await mention(overlapping)
      await Promise.all([
        rpc('runtime.stand_in.assignment', event),
        rpc('runtime.stand_in.assignment', event),
      ])
      await waitForProcessed(overlapping)
      assert.equal(modelTurns, 2, 'The two scopes and repeated delivery must share one execution')

      const assignmentPath = `/v1/loop-items/${assigned.id}`
      const unassigned = await request(assignmentPath, 'PATCH', {
        version: assigned.version,
        assignee_user_id: null,
      })
      assert.equal(unassigned.assignee_user_id, null)
      await request(`${assignmentPath}/assignments`, 'POST', {
        target_type: 'human',
        target_id: String(user.id),
      })
      const current = await request(assignmentPath)
      assert.ok(current.human_task_binding?.assignmentId, 'The real assignment must be active')
      await rpc('runtime.stand_in.assignment', {
        projectId: String(project.id),
        itemId: assigned.id,
        recipientUserId: user.id,
        assignmentId: current.human_task_binding.assignmentId,
      })
      await waitForProcessed(assigned)
      assert.equal(modelTurns, 3, 'An assignment matching both scopes must run once')
      await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: {
          ...settings,
          primary: originalPrimary,
          roles: settings.roles.filter(role => role.id !== ROLE),
        },
      })
    },
  }
}
