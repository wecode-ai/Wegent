import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

const PROJECT_NAME = '评论提及通知验收'
const MENTIONER_NAME = 'desktop-e2e-mentioner'
const MENTIONER_PASSWORD = 'desktop-e2e-mentioner-password'
const ISSUE_TITLE = '评论 @ 必须通知被提及的成员'
const COMMENT_TEXT = '这条评论在验收里 @ 了你，应该收到通知'
const CLIENT_MESSAGE_PREFIX = 'desktop-e2e-mention'
const FLASH_ANIMATION = 'task-detail-comment-flash'

/**
 * How long arriving at the mentioned comment may take.
 *
 * The notification names one comment, so landing on it is a single navigation:
 * a click that walks through the collaboration home and the board list first, or
 * that waits on the workspace after the board is already known, blows the budget.
 */
const COMMENT_BUDGET_MS = 6_000
const FLASH_BUDGET_MS = 8_000

function commentSelectorFor(activeSurface, commentId) {
  return `${activeSurface} [data-testid="cloud-task-activity-message-${commentId}"]`
}

function assertNavigationBudget(label, commentMs, flashMs) {
  assert.ok(
    commentMs <= COMMENT_BUDGET_MS,
    `${label} took ${commentMs}ms to show the mentioned comment (budget ${COMMENT_BUDGET_MS}ms)`
  )
  assert.ok(
    flashMs <= FLASH_BUDGET_MS,
    `${label} took ${flashMs}ms to highlight the comment (budget ${FLASH_BUDGET_MS}ms)`
  )
  console.log(`[e2e] ${label}: comment=${commentMs}ms flash=${flashMs}ms`)
}

async function requestJson(baseUrl, token, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  assert.equal(
    response.ok,
    true,
    `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
  )
  return body
}

async function waitForApiValue(load, predicate, message, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await load()
    if (predicate(latest)) return latest
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  assert.fail(`${message}: ${JSON.stringify(latest)}`)
}

/**
 * The @ notification is produced by the backend when another member comments,
 * so the scenario posts that comment over the same Socket.IO contract the app
 * uses and then drives the recipient's own window through the inbox.
 */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let backendUrl = ''
  let ownerToken = ''
  let owner = null
  let mentioner = null
  let mentionerToken = ''
  let workspace = null
  let project = null
  let issue = null

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)

  async function postMentionComment(messageId) {
    const { io } = createRequire(
      new URL('../../../../packages/chat-core/package.json', import.meta.url)
    )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
    const socket = io(`${backendUrl}/wework-runtime`, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token: mentionerToken },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: uiTimeoutMs,
    })
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
        socket.connect()
      })
      const ack = await socket
        .timeout(uiTimeoutMs)
        .emitWithAck('wework:project_chat:message:send', {
          clientMessageId: messageId,
          projectId: String(project.id),
          taskId: issue.id,
          content: COMMENT_TEXT,
          mentions: [{ type: 'user', id: String(owner.id), label: owner.user_name }],
        })
      assert.equal(ack.ok, true, `Mentioning a member failed: ${JSON.stringify(ack)}`)
      return ack.result
    } finally {
      socket.disconnect()
    }
  }

  async function waitForFlash(control, selector, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let latest = ''
    while (Date.now() < deadline) {
      latest = await control.command('getComputedStyleValue', selector, {
        value: 'animation-name',
      })
      if (latest.includes(FLASH_ANIMATION)) return latest
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    assert.fail(`The mentioned comment never flashed: animation-name=${latest}`)
  }

  /** Wait until the notification's Issue and its comment are both on screen. */
  async function waitForComment(
    control,
    { activeSurface, commentId, issueTitle },
    startedAt,
    timeoutMs
  ) {
    const issueTitleSelector = `${activeSurface} [data-testid="cloud-todo-detail-title"]`
    await control.command('waitFor', issueTitleSelector, { timeoutMs })
    assert.equal(await control.command('getValue', issueTitleSelector), issueTitle)
    const commentSelector = commentSelectorFor(activeSurface, commentId)
    await control.command('waitFor', commentSelector, { text: '@', timeoutMs })
    return Date.now() - startedAt
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      owner = await ownerRequest('/api/users/me')
      mentioner = await ownerRequest('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          user_name: MENTIONER_NAME,
          password: MENTIONER_PASSWORD,
          role: 'user',
          auth_source: 'password',
        }),
      })
      const login = await requestJson(backendUrl, null, '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          user_name: MENTIONER_NAME,
          password: MENTIONER_PASSWORD,
        }),
      })
      mentionerToken = login.access_token
      workspace = await ownerRequest('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: `${PROJECT_NAME}-${process.pid}`,
          description: 'Desktop E2E Workspace for comment mention notifications',
        }),
      })
      project = await ownerRequest(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'MENTION',
          name: PROJECT_NAME,
          description: 'Desktop E2E comment mention notification',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      await ownerRequest(`/api/v1/cloud-projects/${project.id}/members`, {
        method: 'POST',
        body: JSON.stringify({
          user_id: mentioner.id,
          role: 'Developer',
          capability_description: 'Comment on project tasks during desktop E2E',
        }),
      })
      issue = await ownerRequest(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: ISSUE_TITLE }),
      })
    },

    async verify(control) {
      assert.ok(owner?.id, 'Notification recipient fixture is missing')
      assert.ok(mentioner?.id, 'Notification mentioner fixture is missing')
      assert.ok(project?.id, 'Notification project fixture is missing')
      assert.ok(issue?.id, 'Notification Issue fixture is missing')

      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const activeSurface = '[data-workspace-tab-content][aria-hidden="false"]'
      await control.command(
        'waitFor',
        `${activeSurface} [data-testid="collaboration-platform-root"]`,
        { timeoutMs: uiTimeoutMs }
      )

      const message = await postMentionComment(`${CLIENT_MESSAGE_PREFIX}-${Date.now()}`)
      assert.equal(message.sender.name, MENTIONER_NAME)

      const saved = await waitForApiValue(
        async () => {
          const inbox = await ownerRequest('/api/v1/wework-notifications')
          return inbox.items.find(
            item => item.kind === 'mention' && item.payload?.commentId === message.messageId
          )
        },
        Boolean,
        'The mentioned member never received an inbox notification',
        uiTimeoutMs
      )
      assert.equal(
        saved.url,
        `wework://boards/${project.id}/issues/${issue.id}/comments/${message.messageId}`,
        'A mention must link straight at the comment that produced it'
      )
      assert.equal(saved.payload.itemTitle, ISSUE_TITLE)
      assert.ok(saved.payload.itemKey, 'The notification must carry the board item key')
      assert.ok(saved.payload.itemStatus, 'The notification must carry the board column')
      assert.ok(
        saved.payload.commentPreview?.includes('@'),
        'The notification must carry the comment that mentioned the member'
      )

      // The DingTalk push links straight at the comment, so a recipient who taps
      // the deep link lands the same way an inbox click does.
      await reloadMainWindow(
        control,
        'The main window did not come back after reloading for the mention link'
      )
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      const linkStartedAt = Date.now()
      await control.command('openWeworkScheme', 'body', { value: saved.url })
      const linkCommentMs = await waitForComment(
        control,
        { activeSurface, commentId: message.messageId, issueTitle: ISSUE_TITLE },
        linkStartedAt,
        uiTimeoutMs
      )
      await waitForFlash(control, commentSelectorFor(activeSurface, message.messageId), uiTimeoutMs)
      const linkFlashMs = Date.now() - linkStartedAt
      assertNavigationBudget('The DingTalk link', linkCommentMs, linkFlashMs)

      // A fresh window puts the board back at its home, so the inbox click is
      // measured from the same cold start as the link above.
      await reloadMainWindow(
        control,
        'The main window did not come back after reloading for the inbox click'
      )
      await control.command('waitFor', '[data-testid="wework-notifications-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      // A mention is board work, so the bell files it under collaboration.
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      await control.command('waitFor', `[data-testid="wework-notification-${saved.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      const summary = await control.command(
        'getText',
        `[data-testid="wework-notification-${saved.id}-summary"]`
      )
      assert.ok(summary.includes(PROJECT_NAME), `The inbox row must name its board: ${summary}`)
      await captureScreenshot(control, 'comment-notification-01-inbox.png')

      const inboxStartedAt = Date.now()
      await control.command('click', `[data-testid="wework-notification-${saved.id}"]`)
      const inboxCommentMs = await waitForComment(
        control,
        { activeSurface, commentId: message.messageId, issueTitle: ISSUE_TITLE },
        inboxStartedAt,
        uiTimeoutMs
      )
      await waitForFlash(control, commentSelectorFor(activeSurface, message.messageId), uiTimeoutMs)
      const inboxFlashMs = Date.now() - inboxStartedAt
      assertNavigationBudget('Opening the inbox row', inboxCommentMs, inboxFlashMs)
      await captureScreenshot(control, 'comment-notification-02-comment-flashed.png')

      const readInbox = await ownerRequest('/api/v1/wework-notifications')
      assert.ok(
        readInbox.items.find(item => item.id === saved.id)?.read_at,
        'Opening a mention notification must persist its read state'
      )
    },
  }
}
