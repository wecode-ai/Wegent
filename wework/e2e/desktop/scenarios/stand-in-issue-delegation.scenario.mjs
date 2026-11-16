import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { storyUntil } from '../modules/stand-in-source-story-evidence.mjs'
import { createIssueDelegationModel } from '../modules/issue-delegation-model.mjs'

const MARKER = `ISSUE_DELEGATION_${process.pid}`
const ROLE = 'issue-delegation-worker'
const ACK = '收到，我会检查后给出结果。'
const RESULT = '已核实检查结果。'
const PRIVATE = `${MARKER}_PRIVATE_WORKER_EVIDENCE`
const SIMPLE = '这里只需一句简短解释。'
const ANSWER = '这是检查结果的简短解释。'

/** Ordinary assignments delegate without a user asking for subagents. */
export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs }) {
  let cloud, environment, user, project, original, taskId
  const model = createIssueDelegationModel({
    marker: MARKER,
    acknowledgment: ACK,
    result: RESULT,
    privateEvidence: PRIVATE,
    simple: SIMPLE,
    answer: ANSWER,
  })
  async function request(path, body) {
    const response = await fetch(`${cloud.backendUrl}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(uiTimeoutMs),
    })
    const text = await response.text()
    assert.ok(response.ok, `${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const until = (load, ready, label) => storyUntil(load, ready, modelResponseTimeoutMs, label)
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
    handleHttp: model.handleHttp,
    async verify(control) {
      await environment.waitForConnectedAppDevice()
      const rpc = (method, values) => requestExecutor(control, method, values, uiTimeoutMs)
      original = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: {
          ...original,
          roles: [
            ...original.roles,
            {
              ...original.roles[0],
              id: ROLE,
              name: ROLE,
              enabled: true,
              prompt: MARKER,
              collaboration: {
                enabled: true,
                allProjects: false,
                projects: [{ id: String(project.id), store: 'cloud' }],
                excludedProjects: [],
                tags: [MARKER],
                policy: { automatic: true, askBeforeAct: false, immediate: true },
              },
            },
          ],
        },
      })
      const issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
        title: `${MARKER}：检查项目并汇报结果`,
        tags: [MARKER],
        assignee_user_id: user.id,
      })
      const comments = () =>
        request(`/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`)
      const rows = await until(
        comments,
        rows => rows.some(row => row.body === RESULT),
        'Ordinary assignment must return the verified worker result'
      )
      assert.ok(model.state.spawned && model.state.childRan && model.state.completed)
      assert.deepEqual(
        rows.map(row => row.body),
        [ACK, RESULT],
        'Only acceptance and verified result become comments; worker evidence stays private'
      )
      const bindings = await request(`/v1/loop-items/${issue.id}/tasks`)
      assert.equal(bindings.length, 1, 'Native delegation must retain one Issue conversation')
      taskId = bindings[0].task_id
      const settled = () =>
        until(
          () => rpc('runtime.tasks.get', { taskId }),
          value => value.task?.status === 'done' && value.task.running !== true,
          'Issue conversation must finish'
        )
      const first = await settled()
      const activity = `[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-task-activity-${issue.id}"]`
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      await control.command('waitFor', activity, { text: RESULT })
      await control.command(
        'click',
        `${activity} [data-testid="cloud-task-activity-reply-toggle-${rows.find(row => row.body === RESULT).id}"]`
      )
      await control.command('waitFor', '[data-testid="issue-reply-composer"]')
      const form = `${activity} [data-testid="task-comment-form"]`
      await control.command('fill', `${form} [data-testid="cloud-task-activity-composer"]`, {
        value: SIMPLE,
      })
      await control.command('clickWhenEnabled', `${form} [data-testid="send-message-button"]`)
      const final = await until(
        comments,
        rows => rows.some(row => row.body === ANSWER),
        'Simple follow-up must be answered directly in the same conversation'
      )
      assert.equal((await settled()).task.threadId, first.task.threadId)
      assert.deepEqual(
        final.map(row => row.body),
        [ACK, RESULT, SIMPLE, ANSWER]
      )
      await control.command('waitFor', activity, { text: ANSWER })
      const current = await rpc('runtime.stand_in.personal.get', { userId: user.id })
      await rpc('runtime.stand_in.personal.save', {
        userId: user.id,
        settings: { ...current, roles: current.roles.filter(role => role.id !== ROLE) },
      })
    },
    diagnostics() {
      return { projectId: project?.id, taskId, ...model.state }
    },
  }
}
