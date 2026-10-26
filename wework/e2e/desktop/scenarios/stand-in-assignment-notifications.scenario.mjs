import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const MARKER = `STAND_IN_NOTIFICATION_${process.pid}`
const OBSERVATION_MS = 12_000

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud
  let environment
  let user
  let project
  let deviceId
  let settings
  let unmatched
  let matching
  let modelRequests = 0
  const assignmentCounts = {}

  async function request(path, body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function until(load, accept, message) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (accept(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`${message}: ${JSON.stringify(latest)}`)
  }

  async function countAssignments(issue) {
    const log = await readFile(
      join(dirname(environment.backendLogPath), 'backend-rs-logs', 'api.log'),
      'utf8'
    )
    const count = log
      .split('\n')
      .filter(line => line.includes(`[API] GET /api/v1/loop-items/${issue.id}/assignments `)).length
    assignmentCounts[issue.id] = count
    return count
  }

  async function refreshInbox(control) {
    await control.command('click', '[data-testid="wework-notifications-refresh"]')
    await control.command('waitFor', '[data-testid="wework-notifications-refresh"]:not([disabled])')
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const workspace = await request('/v1/workspaces', { name: MARKER })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: MARKER,
        task_provider: 'local',
      })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(req)
      if (
        JSON.stringify(body).includes(MARKER) &&
        !['prewarm', 'compaction'].includes(codexRequestKind(body))
      ) {
        modelRequests += 1
      }
      const id = `${MARKER}-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([responseCreated(id), assistantMessage(MARKER), responseCompleted(id)])
      )
      return true
    },
    async verify(control) {
      const device = await environment.waitForConnectedAppDevice()
      deviceId = device.app_device_id ?? device.device_id
      const params = { projectId: String(project.id), userId: user.id, projectStore: 'cloud' }
      const initial = await requestExecutor(control, 'runtime.stand_in.get', params, uiTimeoutMs)
      settings = await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          ...params,
          settings: { ...initial, enabled: true, prompt: MARKER, tags: ['match'] },
        },
        uiTimeoutMs
      )
      unmatched = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${MARKER} unmatched`,
        assignee_user_id: user.id,
        tags: ['other'],
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await refreshInbox(control)
      const inbox = await request('/v1/wework-notifications?category=collaboration')
      const notice = inbox.items.find(row => row.payload.itemId === unmatched.id)
      assert.ok(notice, 'The real assignment notification must be stored')
      await control.command('waitFor', `[data-testid="wework-notification-${notice.id}"]`)
      // Observe more than two old five-second polling periods on an unhandled assignment.
      await new Promise(resolve => setTimeout(resolve, OBSERVATION_MS))
      assert.equal(await countAssignments(unmatched), 0, 'Unmatched work must not poll assignments')
      assert.deepEqual(await request(`/v1/loop-items/${unmatched.id}/tasks`), [])
      assert.equal(modelRequests, 0)

      matching = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${MARKER} matching`,
        assignee_user_id: user.id,
        tags: ['match'],
      })
      await refreshInbox(control)
      const rows = await until(
        () => request(`/v1/loop-items/${matching.id}/tasks`),
        rows => rows.length === 1,
        'The received notification did not start a stand-in'
      )
      const binding = rows[0]
      assert.equal(binding.device_id, deviceId)
      await until(
        () =>
          requestExecutor(control, 'runtime.tasks.get', { taskId: binding.task_id }, uiTimeoutMs),
        result => {
          assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
          return result.task?.status === 'done'
        },
        'The notification-triggered task did not complete'
      )
      await until(
        () => countAssignments(matching),
        count => count > 0,
        'Assignment validation was not logged'
      )
      assert.equal(await countAssignments(matching), 1, 'Dispatch must validate assignments once')
      for (let index = 0; index < 3; index += 1) await refreshInbox(control)
      await new Promise(resolve => setTimeout(resolve, OBSERVATION_MS))
      assert.equal(await countAssignments(matching), 1, 'Inbox refresh repeated assignment queries')
      assert.equal(await countAssignments(unmatched), 0)
      assert.equal(modelRequests, 1, 'Inbox refresh duplicated stand-in execution')
      assert.deepEqual(await request(`/v1/loop-items/${matching.id}/tasks`), rows)

      await control.command('click', '[data-testid="wework-notifications-button"]')
      await reloadMainWindow(control, 'Notification replay did not recover after reload')
      await control.command('waitFor', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await refreshInbox(control)
      await new Promise(resolve => setTimeout(resolve, OBSERVATION_MS))
      assert.equal(await countAssignments(matching), 1, 'Reload must reuse the existing task')
      assert.equal(await countAssignments(unmatched), 0)
      assert.equal(modelRequests, 1)
      assert.deepEqual(await request(`/v1/loop-items/${matching.id}/tasks`), rows)
      await requestExecutor(
        control,
        'runtime.stand_in.save',
        {
          ...params,
          settings: { ...settings, enabled: false },
        },
        uiTimeoutMs
      )

      // Each connected identity owns one execution for the same real assignment.
      let personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.get',
        { userId: user.id },
        uiTimeoutMs
      )
      const template = personal.roles[0]
      const roleIds = ['fanout-review', 'fanout-docs']
      personal = await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId: user.id,
          settings: {
            ...personal,
            roles: [
              ...personal.roles,
              ...roleIds.map(id => ({
                ...template,
                id,
                name: id,
                enabled: true,
                prompt: `${MARKER} ${id}`,
                version: 0,
                collaboration: { ...template.collaboration, tags: ['fanout'] },
              })),
            ],
          },
        },
        uiTimeoutMs
      )
      const fanout = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${MARKER} independent stand-ins`,
        assignee_user_id: user.id,
        tags: ['fanout'],
      })
      await refreshInbox(control)
      const fanoutBindings = await until(
        () => request(`/v1/loop-items/${fanout.id}/tasks`),
        rows => {
          assert.ok(rows.length <= roleIds.length, 'One identity created duplicate executions')
          return rows.length === roleIds.length
        },
        'Every matching stand-in must bind its own task'
      )
      assert.equal(new Set(fanoutBindings.map(row => row.task_id)).size, roleIds.length)
      assert.equal(new Set(fanoutBindings.map(row => row.human_assignment_id)).size, 1)
      const owners = []
      for (const binding of fanoutBindings) {
        assert.equal(binding.device_id, deviceId)
        await until(
          () =>
            requestExecutor(control, 'runtime.tasks.get', { taskId: binding.task_id }, uiTimeoutMs),
          result => {
            assert.notEqual(result.task?.status, 'failed', JSON.stringify(result))
            return result.task?.status === 'done'
          },
          'An independently dispatched stand-in did not complete'
        )
        const transcript = await requestExecutor(
          control,
          'runtime.tasks.transcript',
          { taskId: binding.task_id, limit: 1 },
          uiTimeoutMs
        )
        owners.push(transcript.origin.standInId)
      }
      assert.deepEqual(owners.sort(), [...roleIds].sort())
      await until(
        () => countAssignments(fanout),
        count => count > 0,
        'Fan-out validation was not logged'
      )
      assert.equal(await countAssignments(fanout), 1, 'Fan-out must share assignment validation')
      assert.equal(
        modelRequests,
        3,
        'Each eligible identity must execute once without AI role selection'
      )
      await refreshInbox(control)
      await new Promise(resolve => setTimeout(resolve, OBSERVATION_MS))
      assert.equal(await countAssignments(fanout), 1)
      assert.equal(modelRequests, 3, 'Inbox refresh must not replay either identity')
      assert.deepEqual(await request(`/v1/loop-items/${fanout.id}/tasks`), fanoutBindings)
      await requestExecutor(
        control,
        'runtime.stand_in.personal.save',
        {
          userId: user.id,
          settings: {
            ...personal,
            roles: personal.roles.map(role => ({ ...role, enabled: false })),
          },
        },
        uiTimeoutMs
      )
    },
    diagnostics() {
      return {
        projectId: project?.id,
        deviceId,
        unmatched: unmatched?.id,
        matching: matching?.id,
        assignmentCounts,
        modelRequests,
      }
    },
  }
}
