import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

const PROJECT_NAME = '评论提及通知验收'
const MENTIONER_NAME = 'desktop-e2e-mentioner'
const MENTIONER_PASSWORD = 'desktop-e2e-mentioner-password'
const ISSUE_TITLE = '评论 @ 必须通知被提及的成员'
const COMMENT_LINK = 'https://github.com/wecode-ai/Wegent/pull/3933'
const COMMENT_DOCUMENT_PATH = '/comment-link-fixture'
const COMMENT_DOCUMENT_TEXT = 'Wework comment link fixture loaded'
const COMMENT_LATEST_DOCUMENT_TEXT = 'Wework latest comment link fixture loaded'
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
/** How long the landed comment must stay on screen to count as the one arrived at. */
const LANDED_STABILITY_MS = 400

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
 * uses and then drives the recipient's own window through the inbox. The same
 * comment carries a recognized GitHub link chip and a plain link so landing
 * from the notification also verifies that both open in the Wework browser
 * without navigating the workbench itself.
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
  let emptyUnreadIssue = null
  let commentDocumentLink = ''
  let pendingCommentDocumentLink = ''
  let latestCommentDocumentLink = ''
  let pendingDocumentResponse = null
  let pendingDocumentRequestCount = 0
  let latestDocumentRequestCount = 0

  const ownerRequest = (pathname, options) => requestJson(backendUrl, ownerToken, pathname, options)
  const commentText = () =>
    [
      '这条评论在验收里 @ 了你，应该收到通知',
      `[wecode-ai/Wegent#3933](${COMMENT_LINK})`,
      `[外链文档](${commentDocumentLink})`,
      `[等待加载的文档](${pendingCommentDocumentLink})`,
      `[最新文档](${latestCommentDocumentLink})`,
    ].join('\n')

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
          content: commentText(),
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
      // The surface the notification opened can still be swapping in, so a
      // missing comment means "not yet", not "never flashed".
      latest = await control
        .command('getComputedStyleValue', selector, { value: 'animation-name' })
        .catch(() => '')
      if (latest.includes(FLASH_ANIMATION)) return latest
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
    assert.fail(`The mentioned comment never flashed: animation-name=${latest}`)
  }

  async function waitForBrowserPage(control, label, expectedUrl, expectedText) {
    const deadline = Date.now() + Math.max(uiTimeoutMs, 30_000)
    let latest = null
    let documentState = null
    let latestError = null
    while (Date.now() < deadline) {
      try {
        latest = JSON.parse(
          await control.command('getEmbeddedBrowserPageState', 'body', { value: label })
        )
      } catch (error) {
        latestError = error instanceof Error ? error.message : String(error)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
        continue
      }
      if (latest.navigationError) {
        assert.fail(
          `The Wework browser failed to open ${expectedUrl}: ${JSON.stringify(
            latest.navigationError
          )}`
        )
      }
      if (
        latest.url &&
        latest.visible &&
        !latest.isLoading &&
        new URL(latest.url).href === new URL(expectedUrl).href
      ) {
        try {
          documentState = JSON.parse(
            await control.command('getEmbeddedBrowserDocumentState', 'body', { value: label })
          )
        } catch (error) {
          latestError = error instanceof Error ? error.message : String(error)
        }
        if (
          documentState?.href === new URL(expectedUrl).href &&
          documentState.readyState === 'complete' &&
          (expectedText === undefined || documentState.bodyText === expectedText)
        ) {
          return latest
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    assert.fail(
      `The Wework browser did not open ${expectedUrl}: ${JSON.stringify({ latest, documentState })}${
        latestError ? ` (${latestError})` : ''
      }`
    )
  }

  async function collaborationBrowserLabel(control, browserPanel) {
    await control.command('waitFor', browserPanel, { visible: true, timeoutMs: uiTimeoutMs })
    const browserLabel = await control.command(
      'getAttribute',
      `${browserPanel} [data-testid="workspace-browser-panel"]`,
      { value: 'data-embedded-browser-label' }
    )
    assert.ok(browserLabel, 'The visible collaboration browser must expose its logical label')
    return browserLabel
  }

  async function closeCommentBrowser(control, activeSurface, routeBeforeClick) {
    const browserPanel = `${activeSurface} [data-testid="collaboration-embedded-browser-panel"]`
    const issueTitle = `${activeSurface} [data-testid="cloud-todo-detail-title"]`
    await control.command(
      'click',
      `${browserPanel} [data-testid="collaboration-embedded-browser-close"]`,
      { visible: true }
    )
    await control.command('waitFor', browserPanel, { visible: false, timeoutMs: uiTimeoutMs })
    await control.command('waitFor', issueTitle, {
      visible: true,
      stableMs: 250,
      timeoutMs: uiTimeoutMs,
    })
    assert.equal(await control.command('getValue', issueTitle), ISSUE_TITLE)
    assert.equal(
      await control.command('getRoute'),
      routeBeforeClick,
      `Clicking an Issue comment link navigated the workbench away from ${routeBeforeClick}`
    )
  }

  async function verifyPendingCommentNavigation(control, activeSurface, routeBeforeClick) {
    const documentLink = url =>
      `${activeSurface} a[data-testid="assistant-markdown-link"][href="${url}"]`
    const browserPanel = `${activeSurface} [data-testid="collaboration-embedded-browser-panel"]`
    let heldResponse = null
    let openingNativeLabel = null
    try {
      await control.command('click', documentLink(pendingCommentDocumentLink), { visible: true })
      heldResponse = await waitForApiValue(
        async () => pendingDocumentResponse,
        Boolean,
        'The first comment document never began loading',
        uiTimeoutMs
      )
      assert.equal(heldResponse.destroyed, false, 'The first request must still be connected')
      assert.equal(heldResponse.writableEnded, false, 'The first response must still be held')
      const browserLabel = await collaborationBrowserLabel(control, browserPanel)
      const openingPage = JSON.parse(
        await control.command('getEmbeddedBrowserPageState', 'body', { value: browserLabel })
      )
      assert.equal(openingPage.visible, true)
      assert.equal(openingPage.navigationError, null)
      assert.equal(openingPage.isLoading, true, 'The first document must still be loading')
      assert.equal(openingPage.url, pendingCommentDocumentLink)
      assert.ok(openingPage.nativeLabel, 'The loading page must identify its native browser')
      openingNativeLabel = openingPage.nativeLabel
      // The held HTTP response keeps the first user-triggered browser.open pending.
      // A second UI click must win when that original native open completes.
      await control.command('click', documentLink(latestCommentDocumentLink), { visible: true })
    } finally {
      if (heldResponse && !heldResponse.destroyed && !heldResponse.writableEnded) {
        heldResponse.end(
          `<!doctype html><title>Pending comment document</title><p>${COMMENT_DOCUMENT_TEXT}</p>`
        )
      }
      if (pendingDocumentResponse === heldResponse) pendingDocumentResponse = null
    }
    for (const requestNumber of [1, 2, 3]) {
      if (requestNumber > 1) {
        await control.command('click', documentLink(latestCommentDocumentLink), { visible: true })
      }
      const loadedPage = await waitForBrowserPage(
        control,
        await collaborationBrowserLabel(control, browserPanel),
        latestCommentDocumentLink,
        `${COMMENT_LATEST_DOCUMENT_TEXT}: request ${requestNumber}`
      )
      if (requestNumber < 3) {
        assert.equal(
          loadedPage.nativeLabel,
          openingNativeLabel,
          'Replacing the pending URL and reloading must reuse the same native browser'
        )
      } else {
        assert.notEqual(
          loadedPage.nativeLabel,
          openingNativeLabel,
          'Reopening a closed panel must create a new native browser'
        )
      }
      console.log(
        `[e2e] Comment browser verified: ${['pending open replacement', 'same URL reload', 'closed panel reopen'][requestNumber - 1]}`
      )
      if (requestNumber !== 1) {
        await closeCommentBrowser(control, activeSurface, routeBeforeClick)
      }
    }
    assert.equal(pendingDocumentRequestCount, 1)
    assert.equal(latestDocumentRequestCount, 3)
  }

  async function verifyCommentLinks(control, activeSurface) {
    const githubLink = `${activeSurface} [data-testid="composer-link-chip"][data-composer-link-url="${COMMENT_LINK}"]`
    const documentLink = `${activeSurface} a[data-testid="assistant-markdown-link"][href="${commentDocumentLink}"]`
    await control.command('waitFor', githubLink, { visible: true, timeoutMs: uiTimeoutMs })
    await control.command('waitFor', documentLink, { visible: true, timeoutMs: uiTimeoutMs })
    await control.command('setAppPreferences', 'body', {
      value: JSON.stringify({
        browserExternalLinkTarget: 'wework',
        browserLocalLinkTarget: 'wework',
      }),
    })

    const routeBeforeClick = await control.command('getRoute')
    const browserPanel = `${activeSurface} [data-testid="collaboration-embedded-browser-panel"]`
    for (const [selector, expectedUrl, expectedText] of [
      [githubLink, COMMENT_LINK],
      [documentLink, commentDocumentLink, COMMENT_DOCUMENT_TEXT],
    ]) {
      await control.command('click', selector, { visible: true })
      await waitForBrowserPage(
        control,
        await collaborationBrowserLabel(control, browserPanel),
        expectedUrl,
        expectedText
      )
      await closeCommentBrowser(control, activeSurface, routeBeforeClick)
    }
    await verifyPendingCommentNavigation(control, activeSurface, routeBeforeClick)
  }

  /**
   * Wait until the notification's Issue and its comment are both on screen.
   *
   * The click a notification answers only navigates once the read it persists
   * comes back, so the surface that was on screen when the click was dispatched
   * can answer a single probe and be replaced right after. Only a surface that
   * keeps showing the Issue and its comment counts as the reader arriving.
   */
  async function waitForComment(
    control,
    { activeSurface, commentId, issueTitle },
    startedAt,
    timeoutMs
  ) {
    const issueTitleSelector = `${activeSurface} [data-testid="cloud-todo-detail-title"]`
    await control.command('waitFor', issueTitleSelector, {
      stableMs: LANDED_STABILITY_MS,
      timeoutMs,
    })
    assert.equal(await control.command('getValue', issueTitleSelector), issueTitle)
    const commentSelector = commentSelectorFor(activeSurface, commentId)
    await control.command('waitFor', commentSelector, {
      stableMs: LANDED_STABILITY_MS,
      text: '@',
      timeoutMs,
    })
    return Date.now() - startedAt
  }

  return {
    requiresCloudEnvironment: true,

    handleHttp(request, response, url) {
      if (request.method !== 'GET' || url.pathname !== COMMENT_DOCUMENT_PATH) return false
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      if (url.searchParams.get('load') === 'pending') {
        pendingDocumentRequestCount += 1
        assert.equal(pendingDocumentRequestCount, 1, 'The pending document was requested twice')
        pendingDocumentResponse = response
        return true
      }
      const text =
        url.searchParams.get('revision') === 'latest'
          ? `${COMMENT_LATEST_DOCUMENT_TEXT}: request ${++latestDocumentRequestCount}`
          : COMMENT_DOCUMENT_TEXT
      response.end(`<!doctype html><title>Wework comment link fixture</title><p>${text}</p>`)
      return true
    },

    cleanup() {
      pendingDocumentResponse?.destroy()
      pendingDocumentResponse = null
    },

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      ownerToken = cloud.authToken
      const modelServerPort = process.env.WEWORK_E2E_MODEL_SERVER_PORT?.trim()
      assert.ok(modelServerPort, 'The desktop E2E model server port is unavailable')
      commentDocumentLink = `http://127.0.0.1:${modelServerPort}${COMMENT_DOCUMENT_PATH}`
      pendingCommentDocumentLink = `${commentDocumentLink}?load=pending`
      latestCommentDocumentLink = `${commentDocumentLink}?revision=latest`
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
      emptyUnreadIssue = await requestJson(
        backendUrl,
        mentionerToken,
        `/api/v1/cloud-projects/${project.id}/loop-items`,
        { method: 'POST', body: JSON.stringify({ title: '打开空讨论后清除未读' }) }
      )
      const unread = await ownerRequest(`/api/v1/loop-items/${emptyUnreadIssue.id}`)
      assert.equal(unread.is_unread, true, 'The other member must create a genuinely unread Issue')
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

      // Empty discussions have no message sequence that could trigger a read.
      // The detail must still persist the content read and update its board card.
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${emptyUnreadIssue.id}`,
      })
      await control.command('waitFor', `${activeSurface} [data-testid="cloud-task-status-event-0"]`)
      const readEmptyIssue = await waitForApiValue(
        () => ownerRequest(`/api/v1/loop-items/${emptyUnreadIssue.id}`),
        value => value.is_unread === false,
        'Opening an Issue with only its creation event did not persist read state',
        uiTimeoutMs
      )
      assert.equal(readEmptyIssue.activity_read_sequence, 0)
      await control.command('click', `${activeSurface} [data-testid="cloud-todo-detail-close"]`)
      const emptyCard = `${activeSurface} [data-testid="cloud-todo-card-${emptyUnreadIssue.id}"]`
      const unreadDot = `${activeSurface} [data-testid="cloud-todo-card-unread-${emptyUnreadIssue.id}"]`
      await control.command('waitFor', emptyCard)
      await control.command('waitFor', unreadDot, { visible: false })
      await control.command('click', emptyCard)
      await control.command('waitFor', `${activeSurface} [data-testid="cloud-task-status-event-0"]`)
      assert.equal(
        (await ownerRequest(`/api/v1/loop-items/${emptyUnreadIssue.id}`)).is_unread,
        false
      )
      await control.command('click', `${activeSurface} [data-testid="cloud-todo-detail-close"]`)
      await control.command('waitFor', unreadDot, { visible: false })

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
      await verifyCommentLinks(control, activeSurface)
      await captureScreenshot(control, 'comment-notification-03-comment-links.png')
      const readIssue = await waitForApiValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        value =>
          value.is_unread === false && value.activity_read_sequence >= message.sequenceNumber,
        'Arriving at the visible comment did not persist the Issue activity cursor',
        uiTimeoutMs
      )
      assert.equal(readIssue.is_unread, false)

      // Reload restores the same mentioned comment. Let that restored highlight
      // finish so the inbox must issue a new focus request, not reuse its flash.
      await reloadMainWindow(
        control,
        'The main window did not come back after reloading for the inbox click'
      )
      await control.command('waitFor', '[data-testid="wework-notifications-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command(
        'waitFor',
        `${activeSurface} [data-testid="collaboration-platform-root"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command(
        'waitFor',
        `${commentSelectorFor(activeSurface, message.messageId)}:not([data-flash="true"])`,
        { visible: true, stableMs: LANDED_STABILITY_MS }
      )
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

      // Extend the scenario after its original navigation and notification checks.
      await control.command('click', `${activeSurface} [data-testid="cloud-todo-detail-close"]`)
      await control.command(
        'waitFor',
        `${activeSurface} [data-testid="collaboration-issue-detail"]`,
        {
          visible: false,
        }
      )
      const boardMessage = await postMentionComment(`${CLIENT_MESSAGE_PREFIX}-board-${Date.now()}`)
      const boardNotification = await waitForApiValue(
        async () => {
          const inbox = await ownerRequest('/api/v1/wework-notifications')
          return inbox.items.find(item => item.payload?.commentId === boardMessage.messageId)
        },
        Boolean,
        'The board regression did not receive its real mention notification',
        uiTimeoutMs
      )
      // Viewing the collaboration board must not display or consume Issue unread state.
      const unreadIssue = await ownerRequest(`/api/v1/loop-items/${issue.id}`)
      assert.equal(unreadIssue.is_unread, true, 'The peer comment must make the Issue unread')
      assert.equal(
        boardNotification.read_at,
        null,
        'The mention notification must initially be unread'
      )
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}`,
      })
      await control.command('waitFor', `${activeSurface} [data-testid="collaboration-tab-board"]`)
      await control.command('click', `${activeSurface} [data-testid="collaboration-tab-board"]`)
      const boardCard = `${activeSurface} [data-testid="cloud-todo-card-drop-${issue.id}"]`
      await control.command('waitFor', boardCard, { text: ISSUE_TITLE, visible: true })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `${boardCard} [data-testid="cloud-todo-card-unread-${issue.id}"]`
          )
        ),
        0,
        'A collaboration Issue card must not show an unread dot'
      )
      const boardCardClasses = await control.command('getAttribute', boardCard, { value: 'class' })
      for (const className of ['border-focus/30', 'bg-focus/10']) {
        assert.ok(
          !boardCardClasses.split(' ').includes(className),
          `A collaboration Issue card must not have unread styling: ${className}`
        )
      }
      assert.equal(
        (await ownerRequest(`/api/v1/loop-items/${issue.id}`)).is_unread,
        true,
        'Viewing the board must preserve the Issue read cursor'
      )
      const boardInbox = await ownerRequest('/api/v1/wework-notifications')
      assert.equal(
        boardInbox.items.find(item => item.id === boardNotification.id)?.read_at,
        null,
        'Viewing the board must preserve the unread mention notification'
      )

      await control.command('click', '[data-testid="wework-notifications-button"]')
      await control.command('click', '[data-testid="wework-notifications-refresh"]')
      await control.command('click', '[data-testid="wework-notifications-category-collaboration"]')
      const notificationRow = `[data-testid="wework-notification-${boardNotification.id}"]`
      await control.command('waitFor', `${notificationRow}[data-unread="true"]`)
      await control.command('click', notificationRow)
      await control.command('waitFor', commentSelectorFor(activeSurface, boardMessage.messageId), {
        text: '@',
        visible: true,
      })
      await waitForApiValue(
        () => ownerRequest(`/api/v1/loop-items/${issue.id}`),
        item =>
          item.is_unread === false &&
          item.activity_read_sequence > unreadIssue.activity_read_sequence,
        'Reading the mentioned comment must advance the Issue activity read cursor',
        uiTimeoutMs
      )
      const finalInbox = await ownerRequest('/api/v1/wework-notifications')
      assert.ok(
        finalInbox.items.find(item => item.id === boardNotification.id)?.read_at,
        'Opening the notification from the board must persist its read state'
      )
    },
  }
}
