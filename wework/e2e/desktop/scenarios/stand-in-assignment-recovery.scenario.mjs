import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { verifyRoundStandInAssignment } from '../modules/stand-in-round-assignment.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, resultDir }) {
  let cloud, user, other, otherToken, project, environment, settings
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
    let latest
    while (Date.now() < deadline) {
      latest = await load()
      if (accept(latest)) return latest
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.fail(`${message}: ${JSON.stringify(latest)}`)
  }
  async function record(stage, issue) {
    const detail = await request(`/v1/loop-items/${issue.id}`)
    const assignments = await request(`/v1/loop-items/${issue.id}/assignments`)
    const tasks = await request(`/v1/loop-items/${issue.id}/tasks`)
    const row = {
      stage,
      issueId: issue.id,
      assignee: detail.assignee_user_id,
      identity: detail.human_task_binding,
      assignments,
      tasks,
    }
    evidence.push(row)
    await writeFile(
      join(resultDir, 'reassignment-evidence.json'),
      JSON.stringify(evidence, null, 2)
    )
    console.log('[stand-in-assignment-recovery]', JSON.stringify(row))
    return detail
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(value) {
      cloud = value
      await request('/admin/setup-complete', {})
      user = await request('/users/me')
      const workspace = await request('/v1/workspaces', { name: 'Reassignment reproduction' })
      project = await request('/v1/cloud-projects', {
        workspace_id: workspace.id,
        name: 'Reassignment reproduction',
        task_provider: 'local',
      })
      other = await request('/admin/users', {
        user_name: `reassignment-member-${process.pid}`,
        password: 'reassignment-e2e-only',
        role: 'user',
        auth_source: 'password',
      })
      otherToken = (
        await request('/auth/login', {
          user_name: other.user_name,
          password: 'reassignment-e2e-only',
        })
      ).access_token
      for (const path of [
        `/v1/workspaces/${workspace.id}/members`,
        `/v1/cloud-projects/${project.id}/members`,
      ]) {
        await request(path, { user_id: other.id, role: 'Developer' })
      }
    },
    setCloudEnvironment(value) {
      environment = value
    },
    async handleHttp(req, response, url) {
      if (req.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      await readRequestBody(req)
      const id = `reassignment-${Date.now()}`
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage('Reassignment work completed.'),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(control) {
      await environment.waitForConnectedAppDevice()
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const params = { projectId: String(project.id), userId: user.id, projectStore: 'cloud' }
      const personal = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      const initial = personal.roles[0]
      settings = await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: {
          ...personal,
          roles: [
            {
              ...initial,
              id: 'recovery-reviewer',
              enabled: true,
              prompt: 'Handle this reassigned Issue.',
              collaboration: {
                ...initial.collaboration,
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
      let issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: 'Process me, transfer away, then transfer back',
        assignee_user_id: user.id,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      const refresh = async () => {
        await control.command('click', '[data-testid="wework-notifications-refresh"]')
        await control.command(
          'waitFor',
          '[data-testid="wework-notifications-refresh"]:not([disabled])'
        )
      }
      await refresh()
      const inbox = await request('/v1/wework-notifications?category=collaboration')
      const notice = inbox.items.find(row => row.payload.itemId === issue.id)
      assert.ok(notice)
      assert.deepEqual(await request(`/v1/loop-items/${issue.id}/tasks`), [])
      const start = `[data-testid="notification-stand-in-start-${notice.id}"]`
      await control.command('waitFor', start)
      await control.command('click', start)
      const firstBindings = await until(
        () => request(`/v1/loop-items/${issue.id}/tasks`),
        rows => rows.length === 1,
        'Initial assignment did not start'
      )
      const firstTask = firstBindings[0].task_id
      assert.ok(
        firstTask.endsWith('-recovery-reviewer'),
        'Manual delegation used an unconfigured identity'
      )
      await until(
        () => rpc('runtime.tasks.get', { taskId: firstTask }),
        value => {
          assert.notEqual(value.task?.status, 'failed', JSON.stringify(value))
          return value.task?.status === 'done'
        },
        'Initial task did not finish'
      )
      issue = await record('first-completed', issue)
      const firstIdentity = issue.human_task_binding
      await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: {
          ...settings,
          roles: settings.roles.map(role => ({
            ...role,
            collaboration: {
              ...role.collaboration,
              policy: { automatic: true, askBeforeAct: false },
            },
          })),
        },
      })
      issue = await request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/assign`, {
        version: issue.version,
        assigneeType: 'user',
        assigneeId: String(other.id),
      })
      issue = await record('assigned-to-other', issue)
      issue = await request(
        `/v1/cloud-projects/${project.id}/loop-items/${issue.id}/assign`,
        {
          version: issue.version,
          assigneeType: 'user',
          assigneeId: String(user.id),
        },
        otherToken
      )
      issue = await record('assigned-back-to-me', issue)
      assert.notEqual(
        issue.human_task_binding?.assignmentId,
        firstIdentity.assignmentId,
        'Returning to the same user reused the old assignment ID'
      )
      assert.notEqual(
        issue.human_task_binding?.humanAssignmentId,
        firstIdentity.humanAssignmentId,
        'Returning to the same user reused the old stand-in identity'
      )
      await refresh()
      const secondBindings = await until(
        () => request(`/v1/loop-items/${issue.id}/tasks`),
        rows => rows.length === 2,
        'Reassignment back to me did not start a new stand-in task'
      )
      const secondTask = secondBindings.find(row => row.task_id !== firstTask)?.task_id
      assert.ok(secondTask)
      await until(
        () => rpc('runtime.tasks.get', { taskId: secondTask }),
        value => {
          assert.notEqual(value.task?.status, 'failed', JSON.stringify(value))
          return value.task?.status === 'done'
        },
        'Second task did not finish'
      )
      const manual = await rpc('runtime.stand_in.run', { ...params, issueId: issue.id })
      assert.equal(
        manual.taskId,
        secondTask,
        'Manual delegation must resolve the second assignment'
      )
      await record('second-completed-and-manual-resolved', issue)
      await verifyRoundStandInAssignment({
        cloud,
        request,
        rpc,
        project,
        user,
        until,
        record,
      })
      console.log(
        '[stand-in-assignment-recovery] PASS: same Issue processed twice after transfer away and back'
      )
    },
    diagnostics() {
      return { projectId: project?.id, evidence }
    },
  }
}
