/**
 * Task runtime consistency E2E regression tests.
 *
 * These tests keep message content on the Socket.IO push path and use the
 * runtime-check pull path only as a lightweight convergence checkpoint.
 */

import { APIRequestContext, BrowserContext, Page, expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { ApiClient, createApiClient } from '../../utils/api-client'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_MODEL_SERVER_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const TEST_PREFIX = `e2e-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const TEST_MODEL_NAME = `${TEST_PREFIX}-model`
const TEST_BOT_NAME = `${TEST_PREFIX}-bot`
const TEST_TEAM_NAME = `${TEST_PREFIX}-team`

type RuntimeCheckResponse = {
  task_id: number
  task_status: string
  active_stream?: {
    subtask_id: number
    cursor: number
    last_activity_at?: string
  } | null
}

type RuntimeCheckTracker = {
  urls: string[]
  count: () => number
}

type SocketDropOptions = {
  chatEvents?: string[]
  terminalTaskStatuses?: string[]
}

test.describe.configure({ mode: 'serial' })

test.describe('Task runtime consistency', () => {
  let apiClient: ApiClient
  let token = ''
  let createdModel = false
  let createdBotId: number | null = null
  let createdTeamId: number | null = null
  let streamRulesForCleanup: string[] = []

  test.beforeAll(async ({ request }) => {
    apiClient = createApiClient(request)
    const loginResponse = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    token = loginResponse.data?.access_token || ''
    expect(token, 'Admin login should return an access token').toBeTruthy()

    const healthResponse = await request.get(`${MOCK_MODEL_SERVER_URL}/health`)
    expect(healthResponse.status(), 'Mock model server should be running').toBe(200)

    await createTestResources(request)
  })

  test.afterAll(async ({ request }) => {
    await cleanupStreamRules(request)
    await cleanupTestResources(request)
  })

  test.afterEach(async ({ request, context }) => {
    await context.setOffline(false).catch(() => {})
    await cleanupStreamRules(request)
  })

  test('streams normally and reaches a terminal UI state', async ({ page, request }) => {
    const runtimeChecks = trackRuntimeChecks(page)
    const messageText = `${TEST_PREFIX} normal streaming request`
    const responseMarker = `${TEST_PREFIX}-normal-response`

    await configureStreamRule(request, messageText, {
      responseContent: `${responseMarker} completed through socket`,
      chunkDelayMs: 40,
    })

    await gotoChatWithTestTeam(page)
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await expect(page.getByTestId('messages-container')).toContainText(responseMarker, {
      timeout: 30000,
    })
    await waitForBackendTerminal(request, taskId)

    await expectChatInputCanSubmit(page, `${TEST_PREFIX} normal readiness probe`)
    await expectNoQueuedMessages(page)
    expect(runtimeChecks.count()).toBeLessThan(8)
  })

  test('keeps previous messages and resumes streaming after page refresh', async ({
    page,
    request,
  }) => {
    const messageText = `${TEST_PREFIX} refresh during streaming request`
    const initialMarker = `${TEST_PREFIX}-refresh-initial`
    const continuationMarker = `${TEST_PREFIX}-refresh-continuation`
    const finalMarker = `${TEST_PREFIX}-refresh-final`

    await configureStreamRule(request, messageText, {
      responseContent: [
        initialMarker,
        'cached',
        'partial',
        'content',
        'before',
        'the',
        'browser',
        'refreshes',
        'and',
        'then',
        continuationMarker,
        'keeps',
        'arriving',
        'after',
        'reload',
        finalMarker,
      ].join(' '),
      chunkDelayMs: 300,
      doneDelayMs: 1500,
    })

    await gotoChatWithTestTeam(page)
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await waitForBackendStatus(request, taskId, ['RUNNING'])
    await expect(page.getByTestId('messages-container')).toContainText(messageText, {
      timeout: 15000,
    })
    await expect(page.getByTestId('messages-container')).toContainText(initialMarker, {
      timeout: 15000,
    })

    await reloadCurrentTaskPage(page)

    await expect(page.getByTestId('messages-container')).toContainText(messageText, {
      timeout: 30000,
    })
    await expect(page.getByTestId('messages-container')).toContainText(initialMarker, {
      timeout: 30000,
    })
    await expect(page.getByTestId('messages-container')).toContainText(continuationMarker, {
      timeout: 30000,
    })
    await expect(page.getByTestId('messages-container')).toContainText(finalMarker, {
      timeout: 30000,
    })
    await waitForBackendTerminal(request, taskId)

    await expectChatInputCanSubmit(page, `${TEST_PREFIX} refresh readiness probe`)
    await expectNoQueuedMessages(page)
    await expectSingleVisibleResponse(page, finalMarker)
  })

  test('restores streaming content after reopening the task page mid-stream', async ({
    context,
    page,
    request,
  }) => {
    const messageText = `${TEST_PREFIX} reopen during streaming request`
    const initialMarker = `${TEST_PREFIX}-reopen-initial`
    const continuationMarker = `${TEST_PREFIX}-reopen-continuation`
    const finalMarker = `${TEST_PREFIX}-reopen-final`

    await configureStreamRule(request, messageText, {
      responseContent: [
        initialMarker,
        'the',
        'original',
        'page',
        'is',
        'closed',
        'while',
        'the',
        'model',
        'continues',
        'streaming',
        'cached',
        'content',
        'for',
        'the',
        'next',
        'page',
        continuationMarker,
        'continues',
        'through',
        'socket',
        'resume',
        'until',
        finalMarker,
      ].join(' '),
      chunkDelayMs: 300,
      doneDelayMs: 1500,
    })

    await gotoChatWithTestTeam(page)
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await waitForBackendStatus(request, taskId, ['RUNNING'])
    await expect(page.getByTestId('messages-container')).toContainText(initialMarker, {
      timeout: 15000,
    })

    const taskUrl = page.url()
    await page.close()
    const recoveredPage = await openTaskPageInFreshTab(context, taskUrl)

    await expect(recoveredPage.getByTestId('messages-container')).toContainText(messageText, {
      timeout: 30000,
    })
    await expect(recoveredPage.getByTestId('messages-container')).toContainText(initialMarker, {
      timeout: 30000,
    })
    await expect(recoveredPage.getByTestId('messages-container')).toContainText(
      continuationMarker,
      { timeout: 30000 }
    )
    await expect(recoveredPage.getByTestId('messages-container')).toContainText(finalMarker, {
      timeout: 30000,
    })
    await waitForBackendTerminal(request, taskId)

    await expectChatInputCanSubmit(recoveredPage, `${TEST_PREFIX} reopen readiness probe`)
    await expectNoQueuedMessages(recoveredPage)
    await expectSingleVisibleResponse(recoveredPage, finalMarker)
  })

  test('recovers when the terminal push event is missed while returning from background', async ({
    page,
    request,
  }) => {
    const socketDropper = await dropTerminalSocketEvents(page)
    const runtimeChecks = trackRuntimeChecks(page)
    const messageText = `${TEST_PREFIX} background terminal loss request`
    const responseMarker = `${TEST_PREFIX}-background-response`

    await configureStreamRule(request, messageText, {
      responseContent: `${responseMarker} finished while page was hidden`,
      chunkDelayMs: 40,
    })

    await gotoChatWithTestTeam(page)
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await expect(page.getByTestId('messages-container')).toContainText(responseMarker, {
      timeout: 30000,
    })
    await waitForBackendTerminal(request, taskId)

    await expect
      .poll(() => socketDropper.droppedMessages.length, {
        message: 'Socket terminal events should be dropped by the E2E fault injection',
        timeout: 10000,
      })
      .toBeGreaterThan(0)

    const checksBeforeVisible = runtimeChecks.count()
    await simulateHiddenThenVisible(page)

    await expect
      .poll(() => runtimeChecks.count(), {
        message: 'Returning to visible should trigger runtime-check',
        timeout: 15000,
      })
      .toBeGreaterThan(checksBeforeVisible)

    await expectChatInputCanSubmit(page, `${TEST_PREFIX} background readiness probe`)
    await expectNoQueuedMessages(page)
    await expectSingleVisibleResponse(page, responseMarker)
  })

  test('recovers after the browser network disconnects during streaming', async ({
    context,
    page,
    request,
  }) => {
    const runtimeChecks = trackRuntimeChecks(page)
    const messageText = `${TEST_PREFIX} network disconnect request`
    const responseMarker = `${TEST_PREFIX}-network-response`

    await configureStreamRule(request, messageText, {
      responseContent: `${responseMarker} recovered after reconnect`,
      chunkDelayMs: 250,
      doneDelayMs: 2000,
    })

    await gotoChatWithTestTeam(page)
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await expect(page.getByTestId('messages-container')).toContainText(responseMarker, {
      timeout: 10000,
    })

    await disconnectBrowserNetwork(context)
    await waitForBackendTerminal(request, taskId)

    const checksBeforeReconnect = runtimeChecks.count()
    await reconnectBrowserNetwork(context, page)

    await expect
      .poll(() => runtimeChecks.count(), {
        message: 'Socket reconnect should trigger runtime-check',
        timeout: 30000,
      })
      .toBeGreaterThan(checksBeforeReconnect)

    await expect(page.getByTestId('messages-container')).toContainText(responseMarker, {
      timeout: 30000,
    })
    await expectChatInputCanSubmit(page, `${TEST_PREFIX} network readiness probe`)
    await expectNoQueuedMessages(page)
  })

  test('recovers RUNNING with unknown stream through the state machine probe', async ({
    page,
    request,
  }) => {
    const socketDropper = await dropChatStartSocketEvents(page)
    const runtimeChecks = trackRuntimeChecks(page)
    const messageText = `${TEST_PREFIX} unknown stream probe request`
    const responseMarker = `${TEST_PREFIX}-unknown-response`

    await configureStreamRule(request, messageText, {
      responseContent: [
        responseMarker,
        'keeps',
        'streaming',
        'after',
        'the',
        'start',
        'event',
        'is',
        'lost',
        'so',
        'runtime',
        'probe',
        'can',
        'resume',
      ].join(' '),
      chunkDelayMs: 250,
      doneDelayMs: 3000,
    })

    await gotoChatWithTestTeam(page)
    const checksBeforeSend = runtimeChecks.count()
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await waitForBackendTerminal(request, taskId)

    await expect
      .poll(() => socketDropper.droppedMessages.some(message => message.includes('chat:start')), {
        message: 'The E2E fault injection should drop chat:start',
        timeout: 10000,
      })
      .toBe(true)

    await expect
      .poll(() => runtimeChecks.count(), {
        message: 'Dropped chat:start should trigger the internal runtime probe',
        timeout: 15000,
      })
      .toBeGreaterThan(checksBeforeSend)

    await expect(page.getByTestId('messages-container')).toContainText(responseMarker, {
      timeout: 30000,
    })
    await expectChatInputCanSubmit(page, `${TEST_PREFIX} unknown readiness probe`)
    await expectNoQueuedMessages(page)
  })

  test('recovers when stream cancellation ack events are missed', async ({ page, request }) => {
    const socketDropper = await dropTerminalSocketEvents(page)
    const runtimeChecks = trackRuntimeChecks(page)
    const messageText = `${TEST_PREFIX} cancel ack probe request`
    const responseMarker = `${TEST_PREFIX}-cancel-response`

    await configureStreamRule(request, messageText, {
      responseContent: [
        responseMarker,
        'keeps',
        'streaming',
        'long',
        'enough',
        'for',
        'the',
        'browser',
        'to',
        'send',
        'a',
        'stop',
        'request',
        'before',
        'the',
        'model',
        'finishes',
      ].join(' '),
      chunkDelayMs: 250,
      doneDelayMs: 20000,
    })

    await gotoChatWithTestTeam(page)
    await sendChatMessage(page, messageText)

    const taskId = await waitForTaskId(page)
    await expect(page.getByTestId('messages-container')).toContainText(responseMarker, {
      timeout: 15000,
    })

    const checksBeforeStop = runtimeChecks.count()
    await stopActiveStream(page)
    await waitForBackendStatus(request, taskId, ['CANCELLED'])

    await expect
      .poll(() => socketDropper.droppedMessages.some(message => message.includes('CANCELLED')), {
        message: 'The E2E fault injection should drop cancellation terminal events',
        timeout: 10000,
      })
      .toBe(true)

    await expect
      .poll(() => runtimeChecks.count(), {
        message: 'Missing cancellation ack should trigger the internal runtime probe',
        timeout: 20000,
      })
      .toBeGreaterThan(checksBeforeStop)

    await expectChatInputCanSubmit(page, `${TEST_PREFIX} cancel readiness probe`)
    await expectNoQueuedMessages(page)
  })

  async function createTestResources(request: APIRequestContext): Promise<void> {
    const modelResponse = await request.post(`${API_BASE_URL}/api/v1/namespaces/default/models`, {
      headers: authHeaders(),
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: TEST_MODEL_NAME,
          namespace: 'default',
        },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'mock-runtime-model',
              api_key: 'mock-api-key',
              base_url: `${MOCK_MODEL_SERVER_URL}/v1`,
            },
          },
        },
      },
    })
    expect([200, 201]).toContain(modelResponse.status())
    createdModel = true

    const botResponse = await request.post(`${API_BASE_URL}/api/bots`, {
      headers: authHeaders(),
      data: {
        name: TEST_BOT_NAME,
        shell_name: 'Chat',
        agent_config: {
          bind_model: TEST_MODEL_NAME,
          bind_model_type: 'user',
        },
        system_prompt: 'You are a deterministic E2E assistant.',
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(botResponse.status())
    createdBotId = ((await botResponse.json()) as { id?: number }).id ?? null
    expect(createdBotId).not.toBeNull()

    const teamResponse = await request.post(`${API_BASE_URL}/api/teams`, {
      headers: authHeaders(),
      data: {
        name: TEST_TEAM_NAME,
        description: 'E2E team for task runtime consistency tests',
        bots: [
          {
            bot_id: createdBotId,
            bot_prompt: 'Return concise deterministic answers.',
            role: 'worker',
          },
        ],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(teamResponse.status())
    createdTeamId = ((await teamResponse.json()) as { id?: number }).id ?? null
    expect(createdTeamId).not.toBeNull()
  }

  async function cleanupTestResources(request: APIRequestContext): Promise<void> {
    if (createdTeamId) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/teams/${TEST_TEAM_NAME}`, {
          headers: authHeaders(),
        })
        .catch(() => {})
    }

    if (createdBotId) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/bots/${TEST_BOT_NAME}`, {
          headers: authHeaders(),
        })
        .catch(() => {})
    }

    if (createdModel) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/models/${TEST_MODEL_NAME}`, {
          headers: authHeaders(),
        })
        .catch(() => {})
    }
  }

  async function configureStreamRule(
    request: APIRequestContext,
    matchText: string,
    options: {
      responseContent: string
      chunkDelayMs?: number
      doneDelayMs?: number
    }
  ): Promise<void> {
    streamRulesForCleanup.push(matchText)
    const response = await request.post(`${MOCK_MODEL_SERVER_URL}/stream-rules`, {
      data: {
        matchText,
        responseContent: options.responseContent,
        chunkDelayMs: options.chunkDelayMs,
        doneDelayMs: options.doneDelayMs,
      },
    })
    expect(response.status()).toBe(200)
  }

  async function cleanupStreamRules(request: APIRequestContext): Promise<void> {
    const rules = [...streamRulesForCleanup]
    streamRulesForCleanup = []

    await Promise.all(
      rules.map(matchText =>
        request
          .delete(
            `${MOCK_MODEL_SERVER_URL}/stream-rules?matchText=${encodeURIComponent(matchText)}`
          )
          .catch(() => null)
      )
    )
  }

  async function gotoChatWithTestTeam(page: Page): Promise<void> {
    expect(createdTeamId).not.toBeNull()
    await skipOnboardingTour(page)
    await page.goto(`/chat?teamId=${createdTeamId}`)
    await page.waitForLoadState('domcontentloaded')
    await dismissOnboardingTour(page)
    await ensureTestTeamSelected(page)
  }

  async function reloadCurrentTaskPage(page: Page): Promise<void> {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissOnboardingTour(page)
    await expect(page.getByTestId('messages-container')).toBeVisible({ timeout: 30000 })
  }

  async function openTaskPageInFreshTab(context: BrowserContext, taskUrl: string): Promise<Page> {
    const recoveredPage = await context.newPage()
    await skipOnboardingTour(recoveredPage)
    await recoveredPage.goto(taskUrl)
    await recoveredPage.waitForLoadState('domcontentloaded')
    await dismissOnboardingTour(recoveredPage)
    await expect(recoveredPage.getByTestId('messages-container')).toBeVisible({ timeout: 30000 })
    return recoveredPage
  }

  async function sendChatMessage(page: Page, message: string): Promise<void> {
    await fillMessageInput(page, message)
    const sendButton = page.getByTestId('send-button')
    await expect(sendButton).toBeVisible({ timeout: 10000 })
    await expect(sendButton).toBeEnabled({ timeout: 15000 })
    await sendButton.click()
  }

  async function fillMessageInput(page: Page, message: string): Promise<void> {
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible({ timeout: 10000 })
    await input.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
    await page.keyboard.press('Backspace')
    await input.pressSequentially(message)
  }

  async function expectChatInputCanSubmit(page: Page, probeMessage: string): Promise<void> {
    await fillMessageInput(page, probeMessage)
    await expect(page.getByTestId('send-button')).toBeEnabled({ timeout: 30000 })
  }

  async function stopActiveStream(page: Page): Promise<void> {
    const stopButton = page
      .getByTestId('stop-stream-button')
      .or(page.locator('button[title="Stop generating"]'))
      .first()
    await expect(stopButton).toBeVisible({ timeout: 15000 })
    await expect(stopButton).toBeEnabled({ timeout: 15000 })
    await stopButton.click()
  }

  async function expectNoQueuedMessages(page: Page): Promise<void> {
    await expect
      .poll(() => page.getByTestId('queued-message-item').count(), {
        message: 'No queued message should remain after runtime recovery',
        timeout: 10000,
      })
      .toBe(0)
  }

  async function expectSingleVisibleResponse(page: Page, marker: string): Promise<void> {
    await expect
      .poll(async () => {
        const text = await page.getByTestId('messages-container').textContent()
        return text ? text.split(marker).length - 1 : 0
      })
      .toBe(1)
  }

  async function waitForTaskId(page: Page): Promise<number> {
    await expect
      .poll(() => new URL(page.url()).searchParams.get('taskId'), {
        message: 'Chat URL should contain taskId after sending a message',
        timeout: 15000,
      })
      .not.toBeNull()

    const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    expect(Number.isFinite(taskId)).toBe(true)
    return taskId
  }

  async function waitForBackendTerminal(request: APIRequestContext, taskId: number): Promise<void> {
    await waitForBackendStatus(request, taskId, ['COMPLETED', 'COMPLETED_SILENT'])
  }

  async function waitForBackendStatus(
    request: APIRequestContext,
    taskId: number,
    expectedStatuses: string[]
  ): Promise<void> {
    const normalizedExpectedStatuses = new Set(expectedStatuses.map(status => status.toUpperCase()))

    await expect
      .poll(
        async () => {
          const response = await request.get(`${API_BASE_URL}/api/tasks/${taskId}/runtime-check`, {
            headers: authHeaders(),
          })
          if (response.status() !== 200) {
            return `HTTP_${response.status()}`
          }

          const runtime = (await response.json()) as RuntimeCheckResponse
          const status = String(runtime.task_status || '').toUpperCase()
          return normalizedExpectedStatuses.has(status) ? 'EXPECTED' : status
        },
        {
          message: `Backend task ${taskId} should reach one of: ${expectedStatuses.join(', ')}`,
          timeout: 30000,
        }
      )
      .toBe('EXPECTED')
  }

  function trackRuntimeChecks(page: Page): RuntimeCheckTracker {
    const urls: string[] = []
    page.on('request', request => {
      if (/\/api\/tasks\/\d+\/runtime-check/.test(request.url())) {
        urls.push(request.url())
      }
    })

    return {
      urls,
      count: () => urls.length,
    }
  }

  async function dropTerminalSocketEvents(page: Page): Promise<{ droppedMessages: string[] }> {
    return dropSocketEvents(page, {
      chatEvents: ['chat:done', 'chat:error', 'chat:cancelled'],
      terminalTaskStatuses: ['COMPLETED', 'COMPLETED_SILENT', 'FAILED', 'CANCELLED'],
    })
  }

  async function dropChatStartSocketEvents(page: Page): Promise<{ droppedMessages: string[] }> {
    return dropSocketEvents(page, {
      chatEvents: ['chat:start'],
    })
  }

  async function dropSocketEvents(
    page: Page,
    options: SocketDropOptions
  ): Promise<{ droppedMessages: string[] }> {
    const droppedMessages: string[] = []

    await page.routeWebSocket(/\/socket\.io\/.*transport=websocket/, ws => {
      const server = ws.connectToServer()

      ws.onMessage(message => {
        server.send(message)
      })

      server.onMessage(message => {
        const text = typeof message === 'string' ? message : message.toString()
        const isDroppedChatEvent =
          options.chatEvents?.some(eventName => text.includes(eventName)) ?? false
        const isTerminalTaskStatus =
          text.includes('task:status') &&
          (options.terminalTaskStatuses?.some(status => text.includes(status)) ?? false)

        if (isDroppedChatEvent || isTerminalTaskStatus) {
          droppedMessages.push(text)
          return
        }

        ws.send(message)
      })
    })

    return { droppedMessages }
  }

  async function disconnectBrowserNetwork(context: BrowserContext): Promise<void> {
    await context.setOffline(true)
  }

  async function reconnectBrowserNetwork(context: BrowserContext, page: Page): Promise<void> {
    await context.setOffline(false)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'))
    })
  }

  async function simulateHiddenThenVisible(page: Page): Promise<void> {
    await installClockOffset(page)
    await setVisibilityState(page, 'hidden')
    await page.evaluate(() => {
      const win = window as typeof window & { __e2eNowOffsetMs?: number }
      win.__e2eNowOffsetMs = 6000
    })
    await setVisibilityState(page, 'visible')
    await page.bringToFront()
  }

  async function installClockOffset(page: Page): Promise<void> {
    await page.evaluate(() => {
      const win = window as typeof window & {
        __e2eOriginalDateNow?: () => number
        __e2eNowOffsetMs?: number
      }

      if (!win.__e2eOriginalDateNow) {
        win.__e2eOriginalDateNow = Date.now.bind(Date)
        win.__e2eNowOffsetMs = 0
        Date.now = () => win.__e2eOriginalDateNow!() + (win.__e2eNowOffsetMs || 0)
      }
    })
  }

  async function setVisibilityState(page: Page, visibilityState: 'hidden' | 'visible') {
    await page.evaluate(state => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      })
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => state !== 'visible',
      })
      document.dispatchEvent(new Event('visibilitychange'))
    }, visibilityState)
  }

  async function skipOnboardingTour(page: Page): Promise<void> {
    await page.addInitScript(() => {
      localStorage.setItem('user_onboarding_completed', 'true')
      localStorage.removeItem('onboarding_in_progress')
      localStorage.removeItem('onboarding_current_step')
    })
  }

  async function dismissOnboardingTour(page: Page): Promise<void> {
    const driverOverlay = page.locator('.driver-overlay, .driver-popover')
    if (!(await driverOverlay.isVisible({ timeout: 1000 }).catch(() => false))) {
      return
    }

    const closeButton = page
      .locator(
        '.driver-popover-close-btn, button:has-text("跳过"), button:has-text("Skip"), button:has-text("完成"), button:has-text("Done")'
      )
      .first()

    if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeButton.click()
      return
    }

    await page.keyboard.press('Escape')
  }

  async function ensureTestTeamSelected(page: Page): Promise<void> {
    const messageInput = page.getByTestId('message-input')
    if (await messageInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      return
    }

    const agentSelector = page
      .locator('[data-testid="agent-skill-selector-button"], [data-testid="team-selector"]')
      .first()
    await expect(agentSelector).toBeVisible({ timeout: 10000 })
    await agentSelector.click({ force: true })

    const searchInput = page
      .locator('input[placeholder*="Search"], input[placeholder*="搜索"]')
      .last()
    if (await searchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await searchInput.fill(TEST_TEAM_NAME)
    }

    const teamOption = page
      .locator(
        `[data-testid="team-option-${TEST_TEAM_NAME}"], [role="button"]:has-text("${TEST_TEAM_NAME}"), [role="option"]:has-text("${TEST_TEAM_NAME}")`
      )
      .first()
    await expect(teamOption).toBeVisible({ timeout: 10000 })
    await teamOption.click({ force: true })
    await expect(messageInput).toBeVisible({ timeout: 10000 })
  }

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }
})
