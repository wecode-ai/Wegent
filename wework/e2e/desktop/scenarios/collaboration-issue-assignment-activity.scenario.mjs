import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = '负责人分配动态验收'
const ISSUE_TITLE = '每次分配都必须出现在动态中'
const COMMENT = '转派之前保留的讨论，用于核对动态顺序'
const MEMBER_NAME = `desktop-e2e-assignment-member-${process.pid}`
const MEMBER_PASSWORD = 'desktop-e2e-assignment-member-password'
const LOCAL_PROJECT = `本地分配动态-${process.pid}`
const LOCAL_ISSUE = '本地项目分配动态必须保留'

const scoped = selector => `${CONTENT} ${selector}`
const list = scoped('[data-testid="cloud-task-activity-list"]')
const assignmentEvent = index => scoped(`[data-testid="cloud-task-assignment-event-${index}"]`)

/** Real cloud persistence and Electron UI, without starting an AI execution. */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backendUrl
  let ownerToken
  let memberToken
  let owner
  let member
  let project
  let issue
  let commentId

  async function request(path, options = {}, token = ownerToken) {
    const response = await fetch(`${backendUrl}${path}`, {
      ...options,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    const text = await response.text()
    assert.equal(response.ok, true, `${path}: HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function openIssue(control) {
    await control.command('openWeworkScheme', 'body', {
      value: `wework://boards/${project.id}/issues/${issue.id}`,
    })
    const title = scoped('[data-testid="cloud-todo-detail-title"]')
    await control.command('waitFor', title, { timeoutMs: uiTimeoutMs })
    assert.equal(await control.command('getValue', title), ISSUE_TITLE)
    await control.command('waitFor', scoped('[data-testid="cloud-task-status-event-0"]'))
  }

  async function verifyAssignments(control, expected, actor = owner.user_name) {
    for (let index = 0; index < expected.length; index += 1) {
      const { name, action } = expected[index]
      await control.command('waitFor', assignmentEvent(index), {
        text: name,
        timeoutMs: uiTimeoutMs,
      })
      const text = await control.command('getText', assignmentEvent(index))
      if (actor) assert.ok(text.includes(actor), `Assignment ${index} has no actor: ${text}`)
      assert.ok(text.includes(action), `Assignment ${index} has the wrong action: ${text}`)
    }
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${list} [data-testid^="cloud-task-assignment-event-"]`
        )
      ),
      expected.length,
      'The activity must render each saved assignment exactly once'
    )
  }

  async function changeAssignee(control, userId, historyLength, notify = true) {
    await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
    const target = userId ? `user:${userId}` : 'empty'
    await control.command('click', `[data-testid="cloud-todo-detail-assignee-option-${target}"]`)
    assert.equal(
      Number(
        await control.command('getElementCount', '[data-testid="wework-assignment-notify-confirm"]')
      ),
      0,
      'Assignee selection must use the save menu instead of a notification dialog'
    )
    if (notify) {
      await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
        timeoutMs: uiTimeoutMs,
      })
    } else {
      await control.command('click', scoped('[data-testid="cloud-todo-save-options"]'))
      await control.command('click', '[data-testid="cloud-todo-save-without-notification"]', {
        visible: true,
      })
    }
    await control.command('waitFor', scoped('[data-testid="cloud-todo-save"]'), {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', assignmentEvent(historyLength - 1), {
      timeoutMs: uiTimeoutMs,
    })
    issue = await request(`/api/v1/loop-items/${issue.id}`)
    assert.equal(String(issue.assignee_user_id ?? ''), String(userId ?? ''))
    assert.equal(issue.assignment_history.length, historyLength)
  }

  async function verifyTimeline(control) {
    const order = JSON.parse(await control.command('getTestIdOrder', list))
    const chronological = [
      'cloud-task-assignment-event-0',
      `cloud-task-activity-card-${commentId}`,
      'cloud-task-status-event-1',
      'cloud-task-assignment-event-1',
      'cloud-task-assignment-event-2',
      'cloud-task-assignment-event-3',
    ]
    for (let index = 1; index < chronological.length; index += 1) {
      const earlier = order.indexOf(chronological[index - 1])
      const later = order.indexOf(chronological[index])
      assert.ok(
        earlier >= 0 && later > earlier,
        `Assignments, comments and statuses are not chronological: ${JSON.stringify(order)}`
      )
    }
    await control.command(
      'waitFor',
      scoped(`[data-testid="cloud-task-activity-${issue.id}"] > header`),
      { text: '共 7 条', timeoutMs: uiTimeoutMs }
    )
  }

  async function verifyLocalProject(control) {
    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    await createLocalCollaborationProject(control, CONTENT, LOCAL_PROJECT)
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('click', scoped('[data-testid="collaboration-empty-project-create"]'))
    await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), {
      value: LOCAL_ISSUE,
    })
    await control.command('click', scoped('[data-testid="cloud-todo-create-assignee"]'))
    const ownerOption = '[data-testid^="cloud-todo-create-assignee-option-user:"]'
    await control.command('waitFor', ownerOption, { timeoutMs: uiTimeoutMs })
    const localOwner = (await control.command('getText', ownerOption)).trim()
    assert.ok(localOwner, 'The local project did not expose its human owner')
    await control.command('click', ownerOption)
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'), {
      timeoutMs: uiTimeoutMs,
    })
    const title = scoped('[data-testid="cloud-todo-detail-title"]')
    await control.command('waitFor', title, { timeoutMs: uiTimeoutMs })
    assert.equal(await control.command('getValue', title), LOCAL_ISSUE)
    const expected = [{ name: localOwner, action: '指派' }]
    await verifyAssignments(control, expected, null)

    await control.command('click', scoped('[data-testid="cloud-todo-detail-assignee"]'))
    await control.command('click', '[data-testid="cloud-todo-detail-assignee-option-empty"]')
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-save"]'), {
      timeoutMs: uiTimeoutMs,
    })
    await control.command('waitFor', scoped('[data-testid="cloud-todo-save"]'), {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
    expected.push({ name: '未指派', action: '取消指派' })
    await verifyAssignments(control, expected, null)
    const activityId = await control.command(
      'getAttribute',
      scoped('section[data-testid^="cloud-task-activity-"]'),
      { value: 'data-testid' }
    )
    assert.ok(activityId?.startsWith('cloud-task-activity-'))
    const localIssueId = activityId.slice('cloud-task-activity-'.length)
    await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
    await reloadMainWindow(control, 'The desktop did not reconnect after local assignment reload')
    const card = scoped(`[data-testid="cloud-todo-card-${localIssueId}"]`)
    await control.command('waitFor', card, { text: LOCAL_ISSUE, timeoutMs: uiTimeoutMs })
    await control.command('click', card)
    await control.command('waitFor', title, { timeoutMs: uiTimeoutMs })
    assert.equal(await control.command('getValue', title), LOCAL_ISSUE)
    await verifyAssignments(control, expected, null)
    await captureScreenshot(control, 'assignment-activity-02-local-persisted.png', CONTENT)
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      owner = await request('/api/users/me')
      member = await request('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          user_name: MEMBER_NAME,
          password: MEMBER_PASSWORD,
          role: 'user',
          auth_source: 'password',
        }),
      })
      const login = await request(
        '/api/auth/login',
        {
          method: 'POST',
          body: JSON.stringify({ user_name: MEMBER_NAME, password: MEMBER_PASSWORD }),
        },
        null
      )
      memberToken = login.access_token
      const workspace = await request('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: `${PROJECT_NAME}-${process.pid}` }),
      })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'ASSIGNACT',
          name: PROJECT_NAME,
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      await request(`/api/v1/cloud-projects/${project.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: member.id, role: 'Developer' }),
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: ISSUE_TITLE, notify_assignee: false }),
      })
      // Creation defaults to the current human owner and records that assignment.
      assert.equal(String(issue.assignee_user_id), String(owner.id))
      assert.equal(issue.assignment_history.length, 1)
      assert.equal(issue.assignment_history[0].action, 'assign')
      assert.equal(issue.status_history.length, 1)
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await openIssue(control)
      const expected = [{ name: owner.user_name, action: '指派' }]
      await verifyAssignments(control, expected)

      const comment = await request(
        `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`,
        { method: 'POST', body: JSON.stringify({ body: COMMENT }) }
      )
      commentId = comment.id
      assert.ok(commentId, 'The backend did not persist the timeline comment')
      await control.command(
        'waitFor',
        scoped(`[data-testid="cloud-task-activity-message-${commentId}"]`),
        { text: COMMENT, timeoutMs: uiTimeoutMs }
      )

      // Statuses and comments share the timeline with assignment history.
      issue = await request(`/api/v1/loop-items/${issue.id}`)
      issue = await request(`/api/v1/loop-items/${issue.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: issue.version, status: 'in_progress' }),
      })
      await control.command('waitFor', scoped('[data-testid="cloud-task-status-event-1"]'), {
        text: '进行中',
        timeoutMs: uiTimeoutMs,
      })

      const previousNotifications = await request('/api/v1/wework-notifications', {}, memberToken)
      await changeAssignee(control, member.id, 2, false)
      expected.push({ name: member.user_name, action: '转派' })
      await verifyAssignments(control, expected)
      const notifications = await request('/api/v1/wework-notifications', {}, memberToken)
      assert.deepEqual(
        notifications.items.map(notification => notification.id).sort(),
        previousNotifications.items.map(notification => notification.id).sort(),
        'Choosing Do not notify must still record activity without sending an assignment notification'
      )

      await changeAssignee(control, null, 3)
      expected.push({ name: '未指派', action: '取消指派' })
      await verifyAssignments(control, expected)

      await changeAssignee(control, owner.id, 4)
      expected.push({ name: owner.user_name, action: '转派' })
      await verifyAssignments(control, expected)
      await verifyTimeline(control)
      const savedHistory = issue.assignment_history

      await reloadMainWindow(control, 'The desktop did not reconnect after assignment reload')
      await openIssue(control)
      await verifyAssignments(control, expected)
      await verifyTimeline(control)
      const persisted = await request(`/api/v1/loop-items/${issue.id}`)
      assert.deepEqual(persisted.assignment_history, savedHistory)
      assert.equal(String(persisted.assignee_user_id), String(owner.id))
      assert.deepEqual(await request(`/api/v1/loop-items/${issue.id}/tasks`), [])
      await captureScreenshot(control, 'assignment-activity-01-cloud-persisted.png', CONTENT)
      await verifyLocalProject(control)
    },

    diagnostics() {
      return { issueId: issue?.id, projectId: project?.id }
    },
  }
}
