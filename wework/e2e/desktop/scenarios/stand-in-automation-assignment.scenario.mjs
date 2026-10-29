import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, resultDir }) {
  let cloud, environment, project, user, other, otherToken
  const evidence = []

  async function request(path, body, token = cloud.authToken) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function until(load, accept, message) {
    const deadline = Date.now() + modelResponseTimeoutMs
    let value
    while (Date.now() < deadline) {
      value = await load()
      if (accept(value)) return value
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`${message}: ${JSON.stringify(value)}`)
  }

  async function record(stage, issue, processingText) {
    const row = {
      stage,
      processingText,
      issueId: issue.id,
      binding: issue.human_task_binding,
      assignments: (await request(`/v1/loop-items/${issue.id}/assignments`)).items,
      tasks: await request(`/v1/loop-items/${issue.id}/tasks`),
    }
    evidence.push(row)
    await writeFile(
      join(resultDir, 'automation-assignment-evidence.json'),
      JSON.stringify(evidence, null, 2)
    )
    return row
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const workspace = await request('/v1/workspaces', {
        name: 'Rust assignment index regression',
      })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: 'Rust assignment index regression',
        task_provider: 'local',
      })
      other = await request('/admin/users', {
        user_name: `automation-assignment-${process.pid}`,
        password: 'automation-assignment-e2e-only',
        role: 'user',
        auth_source: 'password',
      })
      otherToken = (
        await request('/auth/login', {
          user_name: other.user_name,
          password: 'automation-assignment-e2e-only',
        })
      ).access_token
      for (const path of [
        `/v1/workspaces/${workspace.id}/members`,
        `/v1/cloud-projects/${project.id}/members`,
      ])
        await request(path, { user_id: other.id, role: 'Developer' })
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      await readRequestBody(req)
      const id = `automation-assignment-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage('Assigned work completed.'),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      await environment.waitForConnectedAppDevice()
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const failures = []
      for (const automatic of [false, true]) {
        try {
          const personal = await rpc('runtime.stand_in.personal.get', { userId: user.id })
          const role = personal.roles[0]
          let settings = await rpc('runtime.stand_in.personal.save', {
            userId: user.id,
            settings: {
              ...personal,
              roles: [
                {
                  ...role,
                  enabled: true,
                  prompt: 'Handle this assigned Issue.',
                  collaboration: {
                    ...role.collaboration,
                    enabled: true,
                    allProjects: false,
                    projects: [{ id: String(project.id), store: 'cloud' }],
                    tags: [],
                    policy: { automatic: false, askBeforeAct: false },
                  },
                },
              ],
            },
          })
          const created = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
            title: `Stale automation index ${automatic ? 'automatic' : 'manual'} stand-in`,
            assignee_user_id: other.id,
          })
          const before = await request(`/v1/loop-items/${created.id}/assignments`)
          assert.equal(before.items.length, 1)
          await request(
            `/v1/cloud-projects/${project.id}/loop-items/${created.id}/assign`,
            {
              version: created.version,
              assigneeType: 'user',
              assigneeId: String(user.id),
            },
            otherToken
          )
          const issue = await request(`/v1/loop-items/${created.id}`)
          assert.ok(issue.human_task_binding, 'The recipient must see its own assignment identity')
          // Reproduce the exact persisted pre-fix Rust writer state: new assignment
          // events and notification, with the v1 index still pointing at the old event.
          // Real writer transaction coverage lives in assignment_index_mysql_tests.rs.
          const oldId = before.items[0].id
          const oldIndexId = createHash('sha256').update(`active-assignment:${oldId}`).digest('hex')
          await cloud.executeDatabase(
            "UPDATE loop_items SET id=%s,loop_item_id=%s WHERE parent_id=%s AND resource_type='assignment_index' AND loop_item_id=%s",
            [oldIndexId, oldId, issue.id, issue.human_task_binding.assignmentId]
          )
          await cloud.executeDatabase(
            "UPDATE loop_items SET version=1 WHERE parent_id=%s AND resource_type='assignment_index'",
            [issue.id]
          )
          const stored = await cloud.queryDatabase(
            "SELECT loop_item_id FROM loop_items WHERE parent_id=%s AND resource_type='assignment_index' AND loop_item_id=%s",
            [issue.id, oldId]
          )
          assert.equal(stored.length, 1, 'The fixture must retain the stale assignment index')
          if (automatic)
            settings = await rpc('runtime.stand_in.personal.save', {
              userId: user.id,
              settings: {
                ...settings,
                roles: settings.roles.map(value => ({
                  ...value,
                  collaboration: {
                    ...value.collaboration,
                    policy: { automatic: true, askBeforeAct: false },
                  },
                })),
              },
            })
          await reloadMainWindow(control, 'The stale assignment notification did not replay')
          // Control registration can precede the titlebar mounting after a reload.
          await control.command('waitFor', '[data-testid="wework-notifications-button"]')
          await control.command('click', '[data-testid="wework-notifications-button"]')
          await control.command(
            'click',
            '[data-testid="wework-notifications-category-collaboration"]'
          )
          await control.command('click', '[data-testid="wework-notifications-refresh"]')
          await control.command(
            'waitFor',
            '[data-testid="wework-notifications-refresh"]:not([disabled])'
          )
          const inbox = await request('/v1/wework-notifications?category=collaboration')
          const notice = inbox.items.find(row => row.payload.itemId === issue.id)
          assert.ok(notice, 'The real recipient notification must be persisted')
          if (!automatic) {
            assert.deepEqual(await request(`/v1/loop-items/${issue.id}/tasks`), [])
            const start = `[data-testid="notification-stand-in-start-${notice.id}"]`
            await control.command('waitFor', start)
            await control.command('click', start)
            await until(
              async () =>
                Number(await control.command('getElementCount', `${start}:not([disabled])`)) +
                Number(
                  await control.command(
                    'getElementCount',
                    `[data-testid="notification-stand-in-status-${notice.id}"]`
                  )
                ),
              value => value > 0,
              'Manual delegation did not settle'
            )
          }
          const row = await record(
            automatic ? 'automatic-replay' : 'manual-click',
            issue,
            await control.command('getText', `[data-testid="notification-processing-${notice.id}"]`)
          )
          assert.equal(row.assignments.length, 1)
          assert.equal(
            row.assignments[0].id,
            issue.human_task_binding.assignmentId,
            'The assignments endpoint returned the stale pre-automation assignment'
          )
          const bindings = await until(
            () => request(`/v1/loop-items/${issue.id}/tasks`),
            rows => rows.length === 1,
            `The ${automatic ? 'automatic' : 'manual'} stand-in did not start`
          )
          const address = await rpc('runtime.stand_in.run', {
            projectId: String(project.id),
            issueId: issue.id,
            userId: user.id,
            projectStore: 'cloud',
          })
          assert.equal(address.taskId, bindings[0].task_id)
          await until(
            () => rpc('runtime.tasks.get', { taskId: address.taskId }),
            value => {
              assert.notEqual(value.task?.status, 'failed', JSON.stringify(value))
              return value.task?.status === 'done'
            },
            'The assigned stand-in work did not complete'
          )
          assert.equal((await request(`/v1/loop-items/${issue.id}/tasks`)).length, 1)
          await record(automatic ? 'automatic-completed' : 'manual-completed', issue)
        } catch (error) {
          failures.push(
            new Error(`${automatic ? 'automatic' : 'manual'}: ${error.message}`, { cause: error })
          )
        }
        if (
          Number(
            await control.command('getElementCount', '[data-testid="wework-notifications-popover"]')
          ) > 0
        ) {
          await control.command('click', '[data-testid="wework-notifications-button"]')
        }
      }
      if (failures.length)
        throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
    },
    diagnostics() {
      return { projectId: project?.id, evidence }
    },
  }
}
