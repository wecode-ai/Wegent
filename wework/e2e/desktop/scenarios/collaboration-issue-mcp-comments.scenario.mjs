import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { createPersonalIssueAccessRegression } from '../modules/personal-issue-access.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const REPORT = 'PR review regression: this report must be visible in the Issue activity.'
const PR_LINK = 'https://github.com/wecode-ai/Wegent/pull/3933'

/** Exercise the real MCP, persistence, Socket.IO and Issue activity UI together. */
export async function createDesktopScenario({
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
}) {
  const storage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  const personalAccess = createPersonalIssueAccessRegression({
    uiTimeoutMs,
    modelResponseTimeoutMs,
  })
  let backendUrl
  let authToken
  let project
  let issue
  let requestId = 0

  async function request(path, options = {}) {
    const response = await fetch(`${backendUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })
    const text = await response.text()
    assert.equal(response.ok, true, `${path}: HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function callTool(name, args) {
    const response = await request('/mcp/wework-space/sse', {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'tools/call',
        params: {
          name,
          arguments: { space_id: String(project.id), item_id: issue.id, ...args },
        },
      }),
    })
    assert.ok(!response.error, `MCP ${name}: ${JSON.stringify(response.error)}`)
    assert.ok(!response.result.isError, `MCP ${name}: ${JSON.stringify(response.result)}`)
    return JSON.parse(response.result.content.find(block => block.type === 'text').text)
  }

  async function openIssue(control) {
    await control.command('openWeworkScheme', 'body', {
      value: `wework://boards/${project.id}/issues/${issue.id}`,
    })
    await control.command('waitFor', `${CONTENT} [data-testid="cloud-todo-detail-title"]`, {
      timeoutMs: uiTimeoutMs,
    })
  }

  return {
    requiresCloudEnvironment: true,
    backendEnv: storage.backendEnv,
    handleHttp: personalAccess.handleHttp,
    cleanup: storage.stop,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      const workspace = await request('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: `Issue MCP comments ${process.pid}` }),
      })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'MCPREVIEW',
          name: 'PR review MCP comments',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: 'MCP review reports appear in Issue activity' }),
      })
      await personalAccess.prepare(cloud, project, issue)
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await openIssue(control)

      // Tool success and an ID alone do not prove the Issue can display the report.
      const written = await callTool('add_board_item_comment', { body: REPORT })
      assert.ok(written.id, `MCP did not return a persisted comment ID: ${JSON.stringify(written)}`)
      console.log(`[e2e] MCP add_board_item_comment succeeded: comment_id=${written.id}`)
      const reportSelector = `${CONTENT} [data-testid="cloud-task-activity-message-${written.id}"]`
      await control.command('waitFor', reportSelector, { text: REPORT })

      await reloadMainWindow(control, 'The desktop did not reconnect after the comment reload')
      await openIssue(control)
      await control.command('waitFor', reportSelector, { text: REPORT })
      assert.equal(Number(await control.command('getElementCount', reportSelector)), 1)

      // The native Executor uses this REST write path for the same MCP tool.
      const native = await request(
        `/api/v1/cloud-projects/${project.id}/loop-items/${issue.id}/activity-comments`,
        {
          method: 'POST',
          body: JSON.stringify({ body: PR_LINK }),
        }
      )
      await control.command(
        'waitFor',
        `${CONTENT} [data-testid="cloud-task-activity-message-${native.id}"]`,
        { text: PR_LINK }
      )
      const comments = await callTool('list_board_item_comments', {})
      assert.ok(comments.some(comment => comment.id === written.id && comment.body === REPORT))
      assert.ok(comments.some(comment => comment.id === native.id && comment.body === PR_LINK))

      const other = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Other Issue must not contain the review' }),
      })
      const unrelated = await callTool('list_board_item_comments', { item_id: other.id })
      assert.deepEqual(unrelated, [], 'Comment history leaked across Issues')
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${CONTENT} [data-testid="collaboration-error"], ${CONTENT} [data-testid="collaboration-navigation-error"]`
          )
        ),
        0,
        'Issue comments passed while collaboration displayed a loading error'
      )
      console.log(`[e2e] Issue comment assertions completed at ${new Date().toISOString()}`)
      await personalAccess.verify(control)
    },
  }
}
