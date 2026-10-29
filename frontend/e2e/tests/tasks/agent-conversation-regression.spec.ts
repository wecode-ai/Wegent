/**
 * Agent conversation regression tests for CI.
 *
 * These tests use the real frontend, backend, Socket.IO, Chat Shell, and
 * backend execution routing. CI uses:
 * - mock-model-server for Chat Shell, ClaudeCode, and Codex model requests
 * - real executor-manager plus a real coding executor image for ClaudeCode and Codex HTTP tasks
 * - real local executor registered as a Wework app device for device WebSocket tasks
 */

import { APIRequestContext, Page, expect, test, type Route } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { ApiClient, createApiClient } from '../../utils/api-client'
import { createGitHttpFixture } from '../../utils/device-git-http-fixture'
import { settleMentionTasks } from '../../utils/mention-task-fixtures'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_MODEL_SERVER_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const CLAUDE_MODEL_SERVER_URL = process.env.E2E_CLAUDE_MODEL_SERVER_URL || MOCK_MODEL_SERVER_URL
const CODEX_MODEL_SERVER_URL = process.env.E2E_CODEX_MODEL_SERVER_URL || MOCK_MODEL_SERVER_URL
const LOCAL_CLAUDE_MODEL_SERVER_URL =
  process.env.E2E_LOCAL_CLAUDE_MODEL_SERVER_URL || MOCK_MODEL_SERVER_URL
const DEVICE_ID = process.env.E2E_DEVICE_ID || 'e2e-claudecode-device'
const TEST_PREFIX = `e2e-agent-reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const CHAT_MODEL_NAME = `${TEST_PREFIX}-chat-model`
const CLAUDE_MODEL_NAME = `${TEST_PREFIX}-claude-model`
const CODEX_MODEL_NAME = `${TEST_PREFIX}-codex-model`
const DEVICE_CLAUDE_MODEL_NAME = `${TEST_PREFIX}-device-claude-model`
const CLAUDE_SHELL_NAME = `${TEST_PREFIX}-claude-shell`
const CODEX_SHELL_NAME = `${TEST_PREFIX}-codex-shell`
const CODING_EXECUTOR_IMAGE =
  process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const RESPONSE_TIMEOUT_MS = 120_000
// Mock control requests can race with Node closing an idle keep-alive socket.
// Playwright retries only ECONNRESET here and still surfaces HTTP failures.
const MOCK_MODEL_CONTROL_REQUEST_OPTIONS = { maxRetries: 3 } as const

type CreatedTeam = {
  name: string
  id: number
  botName: string
}

type CreatedPipelineTeam = CreatedTeam & {
  stageOneBotName: string
  stageTwoBotName: string
  stageOneMemberPrompt: string
  stageTwoMemberPrompt: string
  stageTwoSystemPrompt: string
}

type RuntimeCheckResponse = {
  task_id: number
  task_status: string
}

type CapturedModelRequest = {
  url: string
  body: unknown
}

type SkillRefMeta = {
  skill_id: number
  namespace: string
  is_public: boolean
  content_hash?: string
}

type InteractiveToolResponse = {
  id: string
  nameIncludes: string
  input: Record<string, unknown>
  text?: string
}

// Fail the transport only: no payload is fabricated, and every other request
// in the flow still reaches the real Backend.
async function loseRealResponse(route: Route): Promise<void> {
  await route.abort('failed')
}

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.describe('Agent conversation regression', () => {
  let apiClient: ApiClient
  let token = ''
  let chatShellTeam: CreatedTeam
  let inheritedClaudeTeam: CreatedTeam
  let claudeChatTeam: CreatedTeam
  let codeTeam: CreatedTeam
  let codexCodeTeam: CreatedTeam
  let deviceTeam: CreatedTeam
  let manualPipelineTeam: CreatedPipelineTeam
  let automaticPipelineTeam: CreatedPipelineTeam
  const createdTaskIds = new Set<number>()
  const createdProjectIds = new Set<number>()
  const createdGitAccountIds = new Set<string>()
  const streamRuleMatchTexts = new Set<string>()
  const toolScenarioMatchTexts = new Set<string>()

  test.beforeAll(async ({ request }) => {
    apiClient = createApiClient(request)
    const loginResponse = await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
    token = loginResponse.data?.access_token || ''
    expect(token, 'Admin login should return an access token').toBeTruthy()

    await expectServiceHealthy(request, `${MOCK_MODEL_SERVER_URL}/health`, 'mock model server')

    await createTestResources(request)
  })

  test.afterEach(async ({ request }) => {
    await cleanupStreamRules(request)
    await cleanupToolScenarios(request)
    await clearMockModelRequests(request)
    await cleanupCreatedTasks(request)
    await cleanupCreatedProjects(request)
    await cleanupCreatedGitAccounts(request)
  })

  test.afterAll(async ({ request }) => {
    await cleanupCreatedTasks(request)
    await cleanupCreatedProjects(request)
    await cleanupCreatedGitAccounts(request)
    await cleanupTestResources(request)
  })

  test('normal mode Chat Shell supports dialogue and follow-up', async ({ page, request }) => {
    const contextToken = makeContextToken('chat_shell')
    const firstPrompt = `Remember this context token for the next turn: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous turn?'
    const followUpMarker = `CHAT_SHELL_FOLLOW_UP_OK_${contextToken}`

    await configureStreamRule(request, followUpPrompt, followUpMarker)
    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await waitForBackendTerminal(request, taskId)

    await sendMessage(page, `${followUpPrompt} Reply with only that token.`)
    await expect(page.getByTestId('messages-container')).toContainText(followUpMarker, {
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await waitForBackendTerminal(request, taskId)

    const secondRequest = await waitForCapturedModelRequest(request, followUpPrompt)
    expect(extractText(secondRequest.body)).toContain(contextToken)
    expect(extractText(secondRequest.body)).toContain(firstPrompt)
  })

  test('handoff mention injects the referenced task and keeps the bubble clean', async ({
    page,
    request,
  }) => {
    const sourceToken = makeContextToken('handoff_source')
    const continuePrompt = `Continue the referenced handoff task ${sourceToken}`
    const continueMarker = `HANDOFF_CONTINUE_OK_${sourceToken}`

    await configureStreamRule(request, continuePrompt, continueMarker)

    // A real previous task with content the reference must carry forward.
    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')
    await sendMessage(page, `Remember this handoff token: ${sourceToken}`)
    const sourceTaskId = await waitForTaskId(page)
    createdTaskIds.add(sourceTaskId)
    await waitForBackendTerminal(request, sourceTaskId)

    // A fresh chat references it through the `@` menu.
    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')
    const input = page.getByTestId('message-input')
    await input.click()
    await input.type('@')

    const menu = page.getByTestId('mention-autocomplete')
    await expect(menu).toBeVisible({ timeout: 10_000 })
    const option = page.getByTestId(`mention-task-option-${sourceTaskId}`)
    await expect(option).toBeVisible({ timeout: 10_000 })
    await option.click()

    // The composer shows a removable reference badge for the selected task.
    const referenceBadge = page.getByTestId(`input-conversation-reference-${sourceTaskId}`)
    await expect(referenceBadge).toBeVisible({ timeout: 10_000 })
    await referenceBadge.getByRole('button').click()
    await expect(referenceBadge).toHaveCount(0)

    // Selecting it again keeps the reference for the send.
    await input.click()
    await input.type('@')
    await expect(page.getByTestId(`mention-task-option-${sourceTaskId}`)).toBeVisible({
      timeout: 10_000,
    })
    await page.getByTestId(`mention-task-option-${sourceTaskId}`).click()

    await input.fill(continuePrompt)
    await page.getByTestId('send-button').click()

    const targetTaskId = await waitForTaskId(page)
    createdTaskIds.add(targetTaskId)
    await waitForBackendTerminal(request, targetTaskId)

    // The reference reaches the model as handoff context for this turn...
    const handoffRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        capture.url.includes('/chat/completions') &&
        extractText(capture.body).includes('<referenced_conversations focus="current">') &&
        extractText(capture.body).includes(sourceToken) &&
        extractText(capture.body).includes(continuePrompt),
      'model request carrying the handoff reference'
    )
    expect(extractText(handoffRequest.body)).toContain(
      'Continue from the final state in the transcript above'
    )

    // ...while the user's own bubble stays free of the transcript.
    const conversation = page.getByTestId('messages-container')
    await expect(conversation).toContainText(continuePrompt, {
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await expect(conversation).toContainText(continueMarker, {
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await expect(conversation).not.toContainText('<referenced_conversations')
  })

  test('handoff mention finds a conversation beyond the first search window', async ({
    page,
    request,
  }) => {
    // The title written by the chat flow is not the raw first message, so the
    // fixture sets the title explicitly after the turn finishes. The task keeps
    // its real conversation and stays outside the sidebar's recent page.
    const historyToken = makeContextToken('history')
    const continuePrompt = `Continue the older handoff task ${historyToken}`
    const continueMarker = `HANDOFF_HISTORY_OK_${historyToken}`

    await configureStreamRule(request, continuePrompt, continueMarker)

    // The referenced conversation is created first, so the filler history
    // pushes it past the first scan window the search used to stop at.
    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')
    await sendMessage(page, historyToken)
    const sourceTaskId = await waitForTaskId(page)
    createdTaskIds.add(sourceTaskId)
    await waitForBackendTerminal(request, sourceTaskId)
    await touchMentionTask(request, sourceTaskId, historyToken)

    await seedMentionTasks(request, 205, index => `Filler conversation ${index}`)

    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')
    const input = page.getByTestId('message-input')
    await input.click()
    // The menu opens on the `@` keystroke; typing the whole query in one burst
    // outruns the state commit and the menu never appears.
    await input.type('@')
    await expect(page.getByTestId('mention-autocomplete')).toBeVisible({ timeout: 10_000 })
    await input.type(historyToken)

    const option = page.getByTestId(`mention-task-option-${sourceTaskId}`)
    await expect(option).toBeVisible({ timeout: 30_000 })
    await option.click()
    await expect(page.getByTestId(`input-conversation-reference-${sourceTaskId}`)).toBeVisible({
      timeout: 10_000,
    })

    await input.fill(continuePrompt)
    await page.getByTestId('send-button').click()

    const targetTaskId = await waitForTaskId(page)
    createdTaskIds.add(targetTaskId)
    await waitForBackendTerminal(request, targetTaskId)

    const handoffRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        capture.url.includes('/chat/completions') &&
        extractText(capture.body).includes(historyToken) &&
        extractText(capture.body).includes(continuePrompt),
      'model request carrying the older handoff conversation'
    )
    const handoffText = extractText(handoffRequest.body)
    expect(handoffText).toContain('<referenced_conversations focus="current">')
    expect(handoffText).toContain(`task_id="${sourceTaskId}"`)

    await expect(page.getByTestId('messages-container')).toContainText(continueMarker, {
      timeout: RESPONSE_TIMEOUT_MS,
    })
  })

  test('handoff mention reaches a project conversation from a later project page', async ({
    page,
    request,
  }) => {
    const projectToken = makeContextToken('handoff_project_page')
    const continuePrompt = `Continue the project handoff task ${projectToken}`
    const continueMarker = `HANDOFF_PROJECT_OK_${projectToken}`

    await configureStreamRule(request, continuePrompt, continueMarker)

    const project = await seedMentionProject(request, `${TEST_PREFIX}-mention-pages`)
    // The candidate is created first so it lands on the project's second page,
    // then touched so it sorts first in the mention list. An empty query keeps
    // the remote title search out of the way: only loading page two can
    // surface this candidate.
    const sourceTaskId = await seedMentionTask(request, {
      title: `Project handoff ${projectToken}`,
      prompt: `Seed project conversation ${projectToken}`,
      projectId: project.id,
    })
    const fillerTaskIds = await seedMentionTasks(
      request,
      55,
      index => `Project filler ${index}`,
      project.id
    )
    await touchMentionTask(request, sourceTaskId, `Project handoff ${projectToken}`, {
      id: project.id,
      taskIds: fillerTaskIds,
    })

    const projectTaskRequests: string[] = []
    page.on('request', outgoing => {
      const url = new URL(outgoing.url())
      if (url.pathname === `/api/projects/${project.id}/tasks`) {
        projectTaskRequests.push(outgoing.url())
      }
    })

    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')
    const input = page.getByTestId('message-input')
    await input.click()
    await input.type('@')

    const option = page.getByTestId(`mention-task-option-${sourceTaskId}`)
    await expect(option).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => projectTaskRequests.some(url => new URL(url).searchParams.has('cursor')), {
        message: 'mention candidates should walk project task pages past the first page',
        timeout: 30_000,
      })
      .toBe(true)
    await option.click()

    await input.fill(continuePrompt)
    await page.getByTestId('send-button').click()

    const targetTaskId = await waitForTaskId(page)
    createdTaskIds.add(targetTaskId)
    await waitForBackendTerminal(request, targetTaskId)

    const handoffRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        capture.url.includes('/chat/completions') &&
        extractText(capture.body).includes(projectToken) &&
        extractText(capture.body).includes(continuePrompt),
      'model request carrying the project page handoff conversation'
    )
    const handoffText = extractText(handoffRequest.body)
    expect(handoffText).toContain('<referenced_conversations focus="current">')
    expect(handoffText).toContain(`task_id="${sourceTaskId}"`)

    await expect(page.getByTestId('messages-container')).toContainText(continueMarker, {
      timeout: RESPONSE_TIMEOUT_MS,
    })
  })

  test('mention candidates survive a lost project page and reload when the menu reopens', async ({
    page,
    request,
  }) => {
    const retryToken = makeContextToken('mention_retry')
    const project = await seedMentionProject(request, `${TEST_PREFIX}-mention-retry`)
    // The later-page candidate is created first so it lands past the first
    // page, then touched so it sorts first once page two finally loads.
    const laterPageTaskId = await seedMentionTask(request, {
      title: `Retry page two ${retryToken}`,
      prompt: `Retry page two ${retryToken}`,
      projectId: project.id,
    })
    const firstPageTaskIds = await seedMentionTasks(
      request,
      55,
      index => `Retry page one ${index}`,
      project.id
    )
    const newestFirstPageTaskId = firstPageTaskIds[firstPageTaskIds.length - 1]
    // Completion order can differ from creation order, so pin both visible candidates.
    await touchMentionTask(
      request,
      newestFirstPageTaskId,
      `Retry page one ${firstPageTaskIds.length - 1}`,
      { id: project.id, taskIds: [laterPageTaskId, ...firstPageTaskIds.slice(0, -1)] }
    )
    await touchMentionTask(request, laterPageTaskId, `Retry page two ${retryToken}`, {
      id: project.id,
      taskIds: firstPageTaskIds,
    })

    const isCursorPage = (url: URL) =>
      url.pathname === `/api/projects/${project.id}/tasks` && url.searchParams.has('cursor')
    let lostCursorPage = false
    const loseCursorPage = async (route: Route) => {
      lostCursorPage = true
      await loseRealResponse(route)
    }
    await page.route(isCursorPage, loseCursorPage)

    await openTaskPage(page, '/chat', chatShellTeam.id, 'chat')
    const input = page.getByTestId('message-input')
    await input.click()
    await input.type('@')

    // The first page lands before the later page is lost, so its candidates
    // stay selectable even though the walk stopped.
    const firstPageOption = page.getByTestId(`mention-task-option-${newestFirstPageTaskId}`)
    await expect(firstPageOption).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => lostCursorPage, {
        message: 'the later project page should have been requested and lost',
        timeout: 30_000,
      })
      .toBe(true)
    await expect(firstPageOption).toBeVisible()
    await expect(page.getByTestId(`mention-task-option-${laterPageTaskId}`)).toHaveCount(0)

    await page.unroute(isCursorPage, loseCursorPage)

    // Reopening the menu retries the failed page instead of keeping the error.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mention-autocomplete')).toHaveCount(0)
    await input.fill('')
    await input.click()
    await input.type('@')
    await expect(page.getByTestId(`mention-task-option-${laterPageTaskId}`)).toBeVisible({
      timeout: 30_000,
    })
  })

  test('saved ClaudeCode agent executes once with inherited base capabilities', async ({
    page,
    request,
  }) => {
    const prompt = `VERIFY_INHERITED_CAPABILITIES_${makeContextToken('inherited_claude')}`

    await openTaskPage(page, '/chat', inheritedClaudeTeam.id, 'chat')
    await sendMessage(page, prompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await waitForBackendTerminal(request, taskId)

    const modelRequest = await waitForCapturedModelRequest(
      request,
      capture => isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(prompt),
      `ClaudeCode model request containing ${prompt}`
    )
    const requestText = extractText(modelRequest.body)
    expect(requestText).toContain('CUSTOM_INHERITED_CLAUDE_IDENTITY')
    expect(requestText).toContain('interactive')
    expect(requestText).toContain('sandbox')
    expect(requestText).not.toContain(
      'You are Wegent, a helpful, harmless, and honest AI assistant.'
    )

    const matchingRequests = (await loadCapturedModelRequests(request)).filter(
      capture => isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(prompt)
    )
    expect(matchingRequests).toHaveLength(1)
  })

  test('normal mode ClaudeCode supports dialogue, follow-up, and session resume', async ({
    page,
    request,
  }) => {
    const contextToken = makeContextToken('claude_chat')
    const firstPrompt = `Remember this context token for the next turn: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous turn?'

    await openTaskPage(page, '/chat', claudeChatTeam.id, 'chat')

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model remembered ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    await sendMessage(page, `${followUpPrompt} Reply with only that token.`)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model resumed with ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    const secondRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(followUpPrompt),
      `ClaudeCode model request containing ${followUpPrompt}`
    )
    expect(extractText(secondRequest.body)).toContain(contextToken)
    expect(extractText(secondRequest.body)).toContain(firstPrompt)
  })

  test('ClaudeCode clarification submits the selected option to the resumed model turn', async ({
    page,
    request,
  }) => {
    const prompt = `CLARIFICATION_DEFER_${makeContextToken('clarification')}`
    const toolUseId = `tool_${makeContextToken('clarification_tool').toLowerCase()}`
    const questionId = 'implementation_scope'
    const selectedValue = 'complete'

    await configureInteractiveFormRule(request, prompt, {
      id: toolUseId,
      nameIncludes: 'interactive_form_question',
      input: {
        questions: [
          {
            id: questionId,
            question: 'Which implementation scope should be used?',
            input_type: 'choice',
            options: [
              {
                label: 'Minimal',
                value: 'minimal',
                description: 'Make the smallest focused change.',
              },
              {
                label: 'Complete',
                value: selectedValue,
                description: 'Cover the full interaction flow.',
                recommended: true,
              },
            ],
            required: true,
            multi_select: false,
          },
        ],
      },
    })
    await openTaskPage(page, '/chat', claudeChatTeam.id, 'chat')

    await sendMessage(page, prompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)

    const initialRequest = await waitForCapturedModelRequest(
      request,
      capture => isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(prompt),
      `ClaudeCode model request containing ${prompt}`
    )
    expect(requestOffersTool(initialRequest.body, 'interactive_form_question')).toBe(true)

    const form = page.getByTestId('ask-user-form')
    await expect(form).toContainText('Which implementation scope should be used?', {
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await page.getByTestId(`ask-user-option-${questionId}-1`).click()
    await page.getByTestId('ask-user-submit').click()

    const resumedRequest = await waitForCapturedModelRequest(
      request,
      capture => {
        return (
          isAnthropicMessagesRequest(capture) &&
          containsInteractiveFormAnswer(capture.body, toolUseId, questionId, selectedValue)
        )
      },
      `ClaudeCode resumed request containing selected clarification option ${selectedValue}`
    )
    expect(
      containsInteractiveFormAnswer(resumedRequest.body, toolUseId, questionId, selectedValue)
    ).toBe(true)
    await waitForBackendTerminal(request, taskId)

    const captures = await loadCapturedModelRequests(request)
    const clarificationRequests = captures.filter(
      capture => isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(prompt)
    )
    expect(clarificationRequests).toHaveLength(2)
    expect(
      containsInteractiveFormAnswer(
        clarificationRequests.at(-1)?.body,
        toolUseId,
        questionId,
        selectedValue
      )
    ).toBe(true)
  })

  test('ClaudeCode preserves a new clarification after answering the previous form', async ({
    page,
    request,
  }) => {
    const prompt = `CONSECUTIVE_CLARIFICATION_${makeContextToken('consecutive_clarification')}`
    const firstToolUseId = `tool_${makeContextToken('first_clarification').toLowerCase()}`
    const secondToolUseId = `tool_${makeContextToken('second_clarification').toLowerCase()}`
    const firstQuestionId = 'implementation_scope'
    const secondQuestionId = 'verification_scope'

    await configureInteractiveFormRule(request, prompt, [
      {
        id: firstToolUseId,
        nameIncludes: 'interactive_form_question',
        input: {
          questions: [
            {
              id: firstQuestionId,
              question: 'Which implementation scope should be used?',
              input_type: 'choice',
              options: [
                {
                  label: 'Minimal',
                  value: 'minimal',
                  description: 'Make the smallest focused change.',
                },
                {
                  label: 'Complete',
                  value: 'complete',
                  description: 'Cover the full interaction flow.',
                },
              ],
              required: true,
              multi_select: false,
            },
          ],
        },
      },
      {
        id: secondToolUseId,
        nameIncludes: 'interactive_form_question',
        text: 'The implementation scope is clear; one verification decision remains.',
        input: {
          questions: [
            {
              id: secondQuestionId,
              question: 'Which verification scope should be used?',
              input_type: 'choice',
              options: [
                {
                  label: 'Focused',
                  value: 'focused',
                  description: 'Run only the focused regression.',
                },
                {
                  label: 'Full',
                  value: 'full',
                  description: 'Run the complete verification suite.',
                },
              ],
              required: true,
              multi_select: false,
            },
          ],
        },
      },
    ])
    await openTaskPage(page, '/chat', claudeChatTeam.id, 'chat')

    await sendMessage(page, prompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)

    const firstForm = page
      .getByTestId('ask-user-form')
      .filter({ hasText: 'Which implementation scope should be used?' })
    await expect(firstForm).toBeVisible({
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await page.getByTestId(`ask-user-option-${firstQuestionId}-1`).click()
    await firstForm.getByTestId('ask-user-submit').click()

    await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) &&
        containsInteractiveFormAnswer(capture.body, firstToolUseId, firstQuestionId, 'complete'),
      'ClaudeCode request containing the first clarification answer'
    )

    const secondForm = page
      .getByTestId('ask-user-form')
      .filter({ hasText: 'Which verification scope should be used?' })
    await expect(secondForm).toBeVisible({
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await page.getByTestId(`ask-user-option-${secondQuestionId}-1`).click()
    await secondForm.getByTestId('ask-user-submit').click()

    await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) &&
        containsInteractiveFormAnswer(capture.body, secondToolUseId, secondQuestionId, 'full'),
      'ClaudeCode request containing the second clarification answer'
    )
    await waitForBackendTerminal(request, taskId)

    const captures = await loadCapturedModelRequests(request)
    const clarificationRequests = captures.filter(
      capture => isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(prompt)
    )
    expect(clarificationRequests).toHaveLength(3)
    expect(
      containsInteractiveFormAnswer(
        clarificationRequests[1]?.body,
        firstToolUseId,
        firstQuestionId,
        'complete'
      )
    ).toBe(true)
    expect(
      containsInteractiveFormAnswer(
        clarificationRequests[2]?.body,
        secondToolUseId,
        secondQuestionId,
        'full'
      )
    ).toBe(true)
  })

  test('coding mode ClaudeCode supports dialogue and follow-up', async ({ page, request }) => {
    const contextToken = makeContextToken('code')
    const firstPrompt = `Remember this code context token: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous code turn?'

    await openTaskPage(page, '/chat?agent=code', codeTeam.id, 'code')

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model remembered ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    await sendMessage(page, `${followUpPrompt} Reply with only that token.`)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model resumed with ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    const secondRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(followUpPrompt),
      `ClaudeCode model request containing ${followUpPrompt}`
    )
    expect(extractText(secondRequest.body)).toContain(contextToken)
    expect(extractText(secondRequest.body)).toContain(firstPrompt)
  })

  test('coding mode Codex executes through app-server and resumes a follow-up', async ({
    page,
    request,
  }) => {
    const contextToken = makeContextToken('codex_code')
    const firstPrompt = `Remember this Codex context token: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous Codex turn?'

    await openTaskPage(page, '/chat?agent=code', codexCodeTeam.id, 'code')

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model remembered ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    const firstRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isOpenAIResponsesRequest(capture) && extractText(capture.body).includes(firstPrompt),
      `Codex Responses request containing ${firstPrompt}`
    )
    expect(firstRequest.url).toContain('/responses')

    await sendMessage(page, `${followUpPrompt} Reply with only that token.`)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model resumed with ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    const secondRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isOpenAIResponsesRequest(capture) && extractText(capture.body).includes(followUpPrompt),
      `resumed Codex Responses request containing ${followUpPrompt}`
    )
    expect(extractText(secondRequest.body)).toContain(contextToken)
    expect(extractText(secondRequest.body)).toContain(firstPrompt)
  })

  test('coding mode Codex uses configured Skill and MCP', async ({ page, request }) => {
    const prompt = `CODEX_SKILL_MCP_E2E_${makeContextToken('capability')}`
    const successMarker = 'CODEX_SKILL_MCP_EFFECTIVE'
    await resetMockMcp(request)
    await configureToolScenario(request, prompt, [
      {
        toolCalls: [
          {
            toolName: 'exec_command',
            arguments: {
              cmd: "test -f .codex/skills/interactive/SKILL.md && printf 'CODEX_SKILL_DEPLOYED'",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: 'get_document_info',
            arguments: { nodeId: 'doc-d1' },
          },
        ],
      },
      { responseContent: successMarker },
    ])

    await openTaskPage(page, '/chat?agent=code', codexCodeTeam.id, 'code')
    await sendMessage(page, prompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await expect(page.getByTestId('messages-container')).toContainText(successMarker, {
      timeout: RESPONSE_TIMEOUT_MS,
    })
    await waitForBackendTerminal(request, taskId)

    const calls = await getMockMcpCalls(request)
    expect(calls).toContainEqual(
      expect.objectContaining({
        name: 'get_document_info',
        arguments: expect.objectContaining({ nodeId: 'doc-d1' }),
        isError: false,
      })
    )
    const captures = await loadCapturedModelRequests(request)
    expect(
      captures.some(capture => JSON.stringify(capture.body).includes('CODEX_SKILL_DEPLOYED'))
    ).toBe(true)
  })

  test('Wework app device supports ClaudeCode dialogue and follow-up', async ({
    page,
    request,
  }) => {
    const contextToken = makeContextToken('device')
    const firstPrompt = `Remember this device context token: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous device turn?'

    await waitForWeworkDeviceOnline(request)
    const deviceResponse = await request.get(`${API_BASE_URL}/api/devices`, {
      headers: authHeaders(),
    })
    expect(deviceResponse.status()).toBe(200)
    const deviceBody = await deviceResponse.json()
    const targetId = deviceBody.items.find(
      (device: { device_id: string }) => device.device_id === DEVICE_ID
    )?.execution_target_id
    expect(targetId).toMatch(/^app-record-\d+$/)
    await configureTaskPagePreferences(page, deviceTeam.id, 'task')
    const [loadedDevices] = await Promise.all([
      page.waitForResponse(
        response =>
          new URL(response.url()).pathname === '/api/devices' &&
          response.request().method() === 'GET'
      ),
      page.goto('/devices', { waitUntil: 'domcontentloaded' }),
    ])
    expect(loadedDevices.status()).toBe(200)
    await expect(page.getByTestId('device-section-local')).toContainText('E2E ClaudeCode Device')
    const startChatButton = page.getByTestId(`start-device-chat-${DEVICE_ID}`)
    await expect(startChatButton).toBeEnabled()
    await startChatButton.click()
    await expect(page).toHaveURL(url => {
      return url.pathname === '/devices/chat' && url.searchParams.get('deviceId') === targetId
    })
    await dismissOnboardingTour(page)
    await ensureMessageInputReady(page)
    const deviceSelector = page.getByTestId('device-chat-target-select')
    await expect(deviceSelector).toHaveValue(targetId)
    await expect(page.getByTestId(`device-chat-option-${targetId}`)).toContainText(
      'E2E ClaudeCode Device'
    )
    await selectModel(page, DEVICE_CLAUDE_MODEL_NAME)

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await expect(page).toHaveURL(url => {
      return url.pathname === '/devices/chat' && url.searchParams.get('taskId') === String(taskId)
    })
    await expect(deviceSelector).toHaveValue(targetId)
    await expect(deviceSelector).toBeDisabled()
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model remembered ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    await sendMessage(page, `${followUpPrompt} Reply with only that token.`)
    await expect(page.getByTestId('messages-container')).toContainText(
      `Mock model resumed with ${contextToken}`,
      { timeout: RESPONSE_TIMEOUT_MS }
    )
    await waitForBackendTerminal(request, taskId)

    const secondRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(followUpPrompt),
      `local ClaudeCode model request containing ${followUpPrompt}`
    )
    expect(extractText(secondRequest.body)).toContain(contextToken)
    expect(extractText(secondRequest.body)).toContain(firstPrompt)
  })

  test('device Git project runs without server AES keys on the executor', async ({ request }) => {
    const gitFixture = await createGitHttpFixture()
    const gitAccountId = `${TEST_PREFIX}-device-git-account`
    const projectName = `${TEST_PREFIX}-device-git-project`
    const contextToken = makeContextToken('device_git')
    const prompt = `Remember this device Git context token: ${contextToken}`

    try {
      await waitForWeworkDeviceOnline(request)

      const gitAccountResponse = await request.put(`${API_BASE_URL}/api/users/me`, {
        headers: authHeaders(),
        data: {
          git_info: [
            {
              id: gitAccountId,
              git_domain: gitFixture.domain,
              git_token: 'device-git-e2e-token',
              type: 'gitea',
            },
          ],
        },
      })
      expect(gitAccountResponse.status()).toBe(200)
      createdGitAccountIds.add(gitAccountId)

      const projectResponse = await request.post(`${API_BASE_URL}/api/projects`, {
        headers: authHeaders(),
        data: {
          name: projectName,
          description: 'E2E project for device-local Git credential transport',
          client_origin: 'frontend',
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: DEVICE_ID,
            },
            workspace: {
              source: 'git',
              checkoutPath: projectName,
            },
            git: {
              url: gitFixture.url,
              repo: 'repository',
              domain: gitFixture.domain,
              branch: 'main',
            },
          },
        },
      })
      expect(projectResponse.status()).toBe(201)
      const project = (await projectResponse.json()) as { id?: number }
      expect(project.id).toBeTruthy()
      createdProjectIds.add(project.id!)

      const taskResponse = await request.post(`${API_BASE_URL}/api/device-chat/tasks`, {
        headers: authHeaders(),
        data: {
          teamId: deviceTeam.id,
          message: prompt,
          deviceId: DEVICE_ID,
          projectId: project.id,
          taskType: 'task',
          clientOrigin: 'frontend',
        },
      })
      expect(taskResponse.status()).toBe(200)
      const task = (await taskResponse.json()) as { taskId?: number }
      expect(task.taskId).toBeTruthy()
      createdTaskIds.add(task.taskId!)

      await waitForBackendTerminal(request, task.taskId!)
      const modelRequest = await waitForCapturedModelRequest(
        request,
        capture =>
          isAnthropicMessagesRequest(capture) && extractText(capture.body).includes(prompt),
        `device Git model request containing ${contextToken}`
      )
      expect(extractText(modelRequest.body)).toContain(contextToken)
    } finally {
      await gitFixture.close()
    }
  })

  test('preserves a draft until the explicitly requested agent is ready', async ({
    page,
    request,
  }) => {
    const prompt = `AGENT_READINESS_${makeContextToken('agent_readiness')}`
    const reply = `AGENT_READINESS_OK_${makeContextToken('agent_readiness_reply')}`
    await configureStreamRule(request, prompt, reply)

    const isRequestedTeam = (url: URL) => url.pathname === `/api/teams/${claudeChatTeam.id}`
    let release!: () => void
    let requested = false
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const holdTeam = async (route: Route) => {
      requested = true
      await gate
      // Delay transport only; the real Backend resolves the requested agent.
      await route.continue()
    }
    await page.route(isRequestedTeam, holdTeam)

    try {
      await openTaskPage(page, '/chat', claudeChatTeam.id, 'chat')
      await expect.poll(() => requested, { timeout: 10_000 }).toBe(true)
      const input = page.getByTestId('message-input')
      await input.fill(prompt)
      await expect(page.getByTestId('send-button')).toBeDisabled()
      await input.press('Enter')
      await expect(input).toContainText(prompt)
      expect(new URL(page.url()).searchParams.get('taskId')).toBeNull()

      const response = page.waitForResponse(response => isRequestedTeam(new URL(response.url())))
      release()
      expect((await response).status()).toBe(200)
      await sendMessage(page, prompt)
      const taskId = await waitForTaskId(page)
      createdTaskIds.add(taskId)
      await expect(page.getByTestId('messages-container')).toContainText(reply, {
        timeout: RESPONSE_TIMEOUT_MS,
      })
      await waitForBackendTerminal(request, taskId)
      const taskResponse = await request.get(`${API_BASE_URL}/api/tasks/${taskId}`, {
        headers: authHeaders(),
      })
      expect(taskResponse.status()).toBe(200)
      const task = (await taskResponse.json()) as { team: { id: number } }
      expect(task.team.id).toBe(claudeChatTeam.id)
    } finally {
      release()
      await page.unroute(isRequestedTeam, holdTeam)
    }
  })

  test('manual pipeline next step sends handoff user message and next bot prompt to the second model', async ({
    page,
    request,
  }) => {
    const firstPrompt = `MANUAL_PIPELINE_USER_MESSAGE_${makeContextToken('manual_pipeline')}`
    const stageOneOutput = `MANUAL_PIPELINE_STAGE_ONE_OUTPUT_${makeContextToken('manual_stage')}`
    const expectedHandoff = `Previous stage output:\n${stageOneOutput}`

    await configureStreamRule(request, firstPrompt, stageOneOutput)
    await openTaskPage(page, '/chat', manualPipelineTeam.id, 'chat')

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)
    await expect(page.getByTestId('messages-container')).toContainText(stageOneOutput, {
      timeout: RESPONSE_TIMEOUT_MS,
    })

    const nextStepButton = page.getByTestId('pipeline-next-step-button')
    await expect(nextStepButton).toBeVisible({ timeout: RESPONSE_TIMEOUT_MS })
    await expect(nextStepButton).toBeEnabled({ timeout: RESPONSE_TIMEOUT_MS })
    await nextStepButton.click()

    await expect(page.getByTestId('pipeline-next-step-message')).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.getByTestId('pipeline-next-step-confirm-button')).toBeDisabled()
    await page.locator('[data-testid^="pipeline-next-step-text-checkbox-ai_response:"]').click()
    await expect(page.getByTestId('pipeline-next-step-confirm-button')).toBeEnabled()
    await page.getByTestId('pipeline-next-step-confirm-button').click()

    const secondStageRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) &&
        requestContainsAll(capture, [
          expectedHandoff,
          manualPipelineTeam.stageTwoMemberPrompt,
          manualPipelineTeam.stageTwoSystemPrompt,
        ]),
      'manual pipeline second-stage model request with handoff and bot prompt'
    )
    const secondStageText = extractText(secondStageRequest.body)
    expect(secondStageText).toContain(expectedHandoff)
    expect(secondStageText).not.toContain('Previous pipeline context')
    expect(secondStageText).toContain(manualPipelineTeam.stageTwoMemberPrompt)
    expect(secondStageText).toContain(manualPipelineTeam.stageTwoSystemPrompt)
    await waitForBackendTerminal(request, taskId)
  })

  test('automatic pipeline next step sends configured user message and next bot prompt to the second model', async ({
    page,
    request,
  }) => {
    const firstPrompt = `AUTO_PIPELINE_USER_MESSAGE_${makeContextToken('auto_pipeline')}`
    const stageOneOutput = `AUTO_PIPELINE_STAGE_ONE_OUTPUT_${makeContextToken('auto_stage')}`
    const expectedHandoff = [
      'Original user request:',
      firstPrompt,
      '',
      'Previous stage output:',
      stageOneOutput,
    ].join('\n')

    await configureStreamRule(request, firstPrompt, stageOneOutput)
    await openTaskPage(page, '/chat', automaticPipelineTeam.id, 'chat')

    await sendMessage(page, firstPrompt)
    const taskId = await waitForTaskId(page)
    createdTaskIds.add(taskId)

    const secondStageRequest = await waitForCapturedModelRequest(
      request,
      capture =>
        isAnthropicMessagesRequest(capture) &&
        requestContainsAll(capture, [
          expectedHandoff,
          automaticPipelineTeam.stageTwoMemberPrompt,
          automaticPipelineTeam.stageTwoSystemPrompt,
        ]),
      'automatic pipeline second-stage model request with configured handoff and bot prompt'
    )
    const secondStageText = extractText(secondStageRequest.body)
    expect(secondStageText).toContain(expectedHandoff)
    expect(secondStageText).toContain(automaticPipelineTeam.stageTwoMemberPrompt)
    expect(secondStageText).toContain(automaticPipelineTeam.stageTwoSystemPrompt)
    await waitForBackendTerminal(request, taskId)
  })

  async function createTestResources(request: APIRequestContext): Promise<void> {
    const chatModelResponse = await request.post(
      `${API_BASE_URL}/api/v1/namespaces/default/models`,
      {
        headers: authHeaders(),
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: {
            name: CHAT_MODEL_NAME,
            namespace: 'default',
          },
          spec: {
            modelConfig: {
              env: {
                model: 'openai',
                model_id: 'mock-model',
                api_key: 'mock-api-key',
                base_url: `${MOCK_MODEL_SERVER_URL}/v1`,
              },
            },
          },
        },
      }
    )
    expect([200, 201]).toContain(chatModelResponse.status())

    const claudeModelResponse = await request.post(
      `${API_BASE_URL}/api/v1/namespaces/default/models`,
      {
        headers: authHeaders(),
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: {
            name: CLAUDE_MODEL_NAME,
            namespace: 'default',
          },
          spec: {
            modelConfig: {
              env: {
                model: 'claude',
                model_id: 'claude-3-5-sonnet-20241022',
                small_model: 'claude-3-5-haiku-20241022',
                api_key: 'mock-api-key',
                ANTHROPIC_API_KEY: 'mock-api-key',
                base_url: `${CLAUDE_MODEL_SERVER_URL}/v1`,
              },
            },
          },
        },
      }
    )
    expect([200, 201]).toContain(claudeModelResponse.status())

    const codexModelResponse = await request.post(
      `${API_BASE_URL}/api/v1/namespaces/default/models`,
      {
        headers: authHeaders(),
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: {
            name: CODEX_MODEL_NAME,
            namespace: 'default',
          },
          spec: {
            protocol: 'openai-responses',
            apiFormat: 'responses',
            modelConfig: {
              env: {
                model: 'openai',
                model_id: 'gpt-5.1-codex',
                api_key: 'mock-api-key',
                OPENAI_API_KEY: 'mock-api-key',
                base_url: `${CODEX_MODEL_SERVER_URL}/v1`,
              },
            },
          },
        },
      }
    )
    expect([200, 201]).toContain(codexModelResponse.status())

    const deviceClaudeModelResponse = await request.post(
      `${API_BASE_URL}/api/v1/namespaces/default/models`,
      {
        headers: authHeaders(),
        data: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: {
            name: DEVICE_CLAUDE_MODEL_NAME,
            namespace: 'default',
          },
          spec: {
            modelConfig: {
              env: {
                model: 'claude',
                model_id: 'claude-3-5-sonnet-20241022',
                small_model: 'claude-3-5-haiku-20241022',
                api_key: 'mock-api-key',
                ANTHROPIC_API_KEY: 'mock-api-key',
                base_url: `${LOCAL_CLAUDE_MODEL_SERVER_URL}/v1`,
              },
            },
          },
        },
      }
    )
    expect([200, 201]).toContain(deviceClaudeModelResponse.status())

    await createCodingShells(request)

    const interactiveSkillRef = await resolveSkillRef(request, 'interactive')
    chatShellTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-chat-shell-team`,
      botName: `${TEST_PREFIX}-chat-shell-bot`,
      shellName: 'Chat',
      bindMode: ['chat'],
      modelName: CHAT_MODEL_NAME,
    })
    inheritedClaudeTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-inherited-claude-team`,
      botName: `${TEST_PREFIX}-inherited-claude-bot`,
      shellName: CLAUDE_SHELL_NAME,
      bindMode: ['chat'],
      modelName: CLAUDE_MODEL_NAME,
      systemPrompt: 'CUSTOM_INHERITED_CLAUDE_IDENTITY',
      inheritBaseCapabilities: true,
    })
    claudeChatTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-claude-chat-team`,
      botName: `${TEST_PREFIX}-claude-chat-bot`,
      shellName: CLAUDE_SHELL_NAME,
      bindMode: ['chat'],
      modelName: CLAUDE_MODEL_NAME,
      skills: ['interactive'],
      skillRefs: { interactive: interactiveSkillRef },
      preloadSkills: ['interactive'],
      preloadSkillRefs: { interactive: interactiveSkillRef },
    })
    codeTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-code-team`,
      botName: `${TEST_PREFIX}-code-bot`,
      shellName: CLAUDE_SHELL_NAME,
      bindMode: ['code'],
      modelName: CLAUDE_MODEL_NAME,
    })
    codexCodeTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-codex-code-team`,
      botName: `${TEST_PREFIX}-codex-code-bot`,
      shellName: CODEX_SHELL_NAME,
      bindMode: ['code'],
      modelName: CODEX_MODEL_NAME,
      skills: ['interactive'],
      skillRefs: { interactive: interactiveSkillRef },
      preloadSkills: ['interactive'],
      preloadSkillRefs: { interactive: interactiveSkillRef },
      mcpServers: {
        'e2e-docs': {
          type: 'streamable-http',
          url: `${CODEX_MODEL_SERVER_URL}/mcp?service=docs`,
        },
      },
    })
    deviceTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-device-team`,
      botName: `${TEST_PREFIX}-device-bot`,
      shellName: CLAUDE_SHELL_NAME,
      bindMode: ['task'],
      modelName: DEVICE_CLAUDE_MODEL_NAME,
    })
    manualPipelineTeam = await createPipelineTeam(request, {
      teamName: `${TEST_PREFIX}-manual-pipeline-team`,
      stageOneBotName: `${TEST_PREFIX}-manual-stage-one-bot`,
      stageTwoBotName: `${TEST_PREFIX}-manual-stage-two-bot`,
      firstStageRequireConfirmation: true,
      firstStageContextPassing: 'none',
      stageOneSystemPrompt: 'MANUAL_PIPELINE_STAGE_ONE_SYSTEM_PROMPT',
      stageOneMemberPrompt: 'MANUAL_PIPELINE_STAGE_ONE_MEMBER_PROMPT',
      stageTwoSystemPrompt: 'MANUAL_PIPELINE_STAGE_TWO_SYSTEM_PROMPT',
      stageTwoMemberPrompt: 'MANUAL_PIPELINE_STAGE_TWO_MEMBER_PROMPT',
    })
    automaticPipelineTeam = await createPipelineTeam(request, {
      teamName: `${TEST_PREFIX}-automatic-pipeline-team`,
      stageOneBotName: `${TEST_PREFIX}-automatic-stage-one-bot`,
      stageTwoBotName: `${TEST_PREFIX}-automatic-stage-two-bot`,
      firstStageRequireConfirmation: false,
      firstStageContextPassing: 'original_and_previous',
      stageOneSystemPrompt: 'AUTOMATIC_PIPELINE_STAGE_ONE_SYSTEM_PROMPT',
      stageOneMemberPrompt: 'AUTOMATIC_PIPELINE_STAGE_ONE_MEMBER_PROMPT',
      stageTwoSystemPrompt: 'AUTOMATIC_PIPELINE_STAGE_TWO_SYSTEM_PROMPT',
      stageTwoMemberPrompt: 'AUTOMATIC_PIPELINE_STAGE_TWO_MEMBER_PROMPT',
    })
  }

  async function createCodingShells(request: APIRequestContext): Promise<void> {
    for (const shell of [
      {
        name: CLAUDE_SHELL_NAME,
        displayName: 'E2E ClaudeCode Executor',
        baseShellRef: 'ClaudeCode',
      },
      {
        name: CODEX_SHELL_NAME,
        displayName: 'E2E Codex Executor',
        baseShellRef: 'Codex',
      },
    ]) {
      const response = await request.post(`${API_BASE_URL}/api/shells`, {
        headers: authHeaders(),
        data: {
          ...shell,
          baseImage: CODING_EXECUTOR_IMAGE,
        },
      })
      expect([200, 201]).toContain(response.status())
    }
  }

  async function createTeam(
    request: APIRequestContext,
    options: {
      teamName: string
      botName: string
      shellName: string
      bindMode: string[]
      modelName: string
      skills?: string[]
      skillRefs?: Record<string, SkillRefMeta>
      preloadSkills?: string[]
      preloadSkillRefs?: Record<string, SkillRefMeta>
      mcpServers?: Record<string, unknown>
      systemPrompt?: string
      inheritBaseCapabilities?: boolean
    }
  ): Promise<CreatedTeam> {
    const botResponse = await request.post(`${API_BASE_URL}/api/bots`, {
      headers: authHeaders(),
      data: {
        name: options.botName,
        shell_name: options.shellName,
        agent_config: {
          bind_model: options.modelName,
          bind_model_type: 'user',
        },
        system_prompt: options.systemPrompt || 'You are a deterministic E2E regression assistant.',
        inherit_base_capabilities: options.inheritBaseCapabilities,
        skills: options.skills,
        skill_refs: options.skillRefs,
        preload_skills: options.preloadSkills,
        preload_skill_refs: options.preloadSkillRefs,
        mcp_servers: options.mcpServers,
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(botResponse.status())
    const botBody = (await botResponse.json()) as { id?: number }
    expect(botBody.id).toBeTruthy()

    const teamResponse = await request.post(`${API_BASE_URL}/api/teams`, {
      headers: authHeaders(),
      data: {
        name: options.teamName,
        description: 'E2E team for agent conversation regression tests',
        bots: [
          {
            bot_id: botBody.id,
            bot_prompt: 'Return concise deterministic answers.',
            role: 'worker',
          },
        ],
        bind_mode: options.bindMode,
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
      },
    })
    expect([200, 201]).toContain(teamResponse.status())
    const teamBody = (await teamResponse.json()) as { id?: number }
    expect(teamBody.id).toBeTruthy()

    return {
      name: options.teamName,
      id: teamBody.id!,
      botName: options.botName,
    }
  }

  async function resolveSkillRef(
    request: APIRequestContext,
    skillName: string
  ): Promise<SkillRefMeta> {
    const response = await request.get(
      `${API_BASE_URL}/api/v1/kinds/skills?name=${encodeURIComponent(skillName)}&namespace=default&exact_match=false`,
      { headers: authHeaders() }
    )
    expect(response.status()).toBe(200)

    const body = (await response.json()) as {
      items?: Array<{
        metadata?: {
          namespace?: string
          labels?: Record<string, string>
        }
        status?: {
          fileHash?: string
        }
      }>
    }
    const skill = body.items?.[0]
    const skillId = Number(skill?.metadata?.labels?.id)
    expect(
      skillId,
      `Skill ${skillName} should expose a numeric metadata.labels.id`
    ).toBeGreaterThan(0)

    const fileHash = skill?.status?.fileHash
    return {
      skill_id: skillId,
      namespace: skill?.metadata?.namespace || 'default',
      is_public: skill?.metadata?.labels?.user_id === '0',
      content_hash: fileHash ? `sha256:${fileHash}` : undefined,
    }
  }

  async function createPipelineTeam(
    request: APIRequestContext,
    options: {
      teamName: string
      stageOneBotName: string
      stageTwoBotName: string
      firstStageRequireConfirmation: boolean
      firstStageContextPassing: 'none' | 'previous_bot' | 'original_user' | 'original_and_previous'
      stageOneSystemPrompt: string
      stageOneMemberPrompt: string
      stageTwoSystemPrompt: string
      stageTwoMemberPrompt: string
    }
  ): Promise<CreatedPipelineTeam> {
    const stageOneBotId = await createBot(request, {
      botName: options.stageOneBotName,
      shellName: CLAUDE_SHELL_NAME,
      modelName: CLAUDE_MODEL_NAME,
      systemPrompt: options.stageOneSystemPrompt,
    })
    const stageTwoBotId = await createBot(request, {
      botName: options.stageTwoBotName,
      shellName: CLAUDE_SHELL_NAME,
      modelName: CLAUDE_MODEL_NAME,
      systemPrompt: options.stageTwoSystemPrompt,
    })

    const teamResponse = await request.post(`${API_BASE_URL}/api/teams`, {
      headers: authHeaders(),
      data: {
        name: options.teamName,
        description: 'E2E team for pipeline handoff request regression tests',
        bots: [
          {
            bot_id: stageOneBotId,
            bot_prompt: options.stageOneMemberPrompt,
            role: 'leader',
            requireConfirmation: options.firstStageRequireConfirmation,
            contextPassing: options.firstStageContextPassing,
          },
          {
            bot_id: stageTwoBotId,
            bot_prompt: options.stageTwoMemberPrompt,
            role: 'worker',
            requireConfirmation: false,
            contextPassing: 'none',
          },
        ],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
        workflow: {
          mode: 'pipeline',
          leader_bot_id: stageOneBotId,
        },
      },
    })
    expect([200, 201]).toContain(teamResponse.status())
    const teamBody = (await teamResponse.json()) as { id?: number }
    expect(teamBody.id).toBeTruthy()

    return {
      name: options.teamName,
      id: teamBody.id!,
      botName: options.stageOneBotName,
      stageOneBotName: options.stageOneBotName,
      stageTwoBotName: options.stageTwoBotName,
      stageOneMemberPrompt: options.stageOneMemberPrompt,
      stageTwoMemberPrompt: options.stageTwoMemberPrompt,
      stageTwoSystemPrompt: options.stageTwoSystemPrompt,
    }
  }

  async function createBot(
    request: APIRequestContext,
    options: {
      botName: string
      shellName: string
      modelName: string
      systemPrompt: string
    }
  ): Promise<number> {
    const response = await request.post(`${API_BASE_URL}/api/bots`, {
      headers: authHeaders(),
      data: {
        name: options.botName,
        shell_name: options.shellName,
        agent_config: {
          bind_model: options.modelName,
          bind_model_type: 'user',
        },
        system_prompt: options.systemPrompt,
        namespace: 'default',
        is_active: true,
      },
    })
    expect([200, 201]).toContain(response.status())
    const body = (await response.json()) as { id?: number }
    expect(body.id).toBeTruthy()
    return body.id!
  }

  async function cleanupTestResources(request: APIRequestContext): Promise<void> {
    for (const team of [
      automaticPipelineTeam,
      manualPipelineTeam,
      deviceTeam,
      codexCodeTeam,
      codeTeam,
      claudeChatTeam,
      inheritedClaudeTeam,
      chatShellTeam,
    ]) {
      if (!team) continue
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/teams/${team.name}`, {
          headers: authHeaders(),
        })
        .catch(() => null)
      const botNames = isPipelineTeam(team)
        ? [team.stageOneBotName, team.stageTwoBotName]
        : [team.botName]
      for (const botName of botNames) {
        await request
          .delete(`${API_BASE_URL}/api/v1/namespaces/default/bots/${botName}`, {
            headers: authHeaders(),
          })
          .catch(() => null)
      }
    }

    for (const modelName of [
      DEVICE_CLAUDE_MODEL_NAME,
      CODEX_MODEL_NAME,
      CLAUDE_MODEL_NAME,
      CHAT_MODEL_NAME,
    ]) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/models/${modelName}`, {
          headers: authHeaders(),
        })
        .catch(() => null)
    }

    for (const shellName of [CODEX_SHELL_NAME, CLAUDE_SHELL_NAME]) {
      await request
        .delete(`${API_BASE_URL}/api/shells/${shellName}`, {
          headers: authHeaders(),
        })
        .catch(() => null)
    }
  }

  async function cleanupCreatedTasks(request: APIRequestContext): Promise<void> {
    const taskIds = [...createdTaskIds]
    createdTaskIds.clear()
    await Promise.all(
      taskIds.map(taskId =>
        request
          .delete(`${API_BASE_URL}/api/tasks/${taskId}`, {
            headers: authHeaders(),
          })
          .catch(() => null)
      )
    )
  }

  async function cleanupCreatedProjects(request: APIRequestContext): Promise<void> {
    const projectIds = [...createdProjectIds]
    createdProjectIds.clear()
    for (const projectId of projectIds) {
      const response = await request.delete(`${API_BASE_URL}/api/projects/${projectId}`, {
        headers: authHeaders(),
      })
      expect(response.status()).toBe(204)
    }
  }

  async function cleanupCreatedGitAccounts(request: APIRequestContext): Promise<void> {
    const accountIds = [...createdGitAccountIds]
    createdGitAccountIds.clear()
    for (const accountId of accountIds) {
      const response = await request.delete(
        `${API_BASE_URL}/api/users/me/git-token/e2e?git_info_id=${encodeURIComponent(accountId)}`,
        { headers: authHeaders() }
      )
      expect(response.status()).toBe(200)
    }
  }

  async function configureStreamRule(
    request: APIRequestContext,
    matchText: string,
    responseContent: string
  ): Promise<void> {
    streamRuleMatchTexts.add(matchText)
    const response = await request.post(`${MOCK_MODEL_SERVER_URL}/stream-rules`, {
      ...MOCK_MODEL_CONTROL_REQUEST_OPTIONS,
      data: {
        matchText,
        responseContent,
        chunkDelayMs: 20,
      },
    })
    expect(response.status()).toBe(200)
  }

  async function configureInteractiveFormRule(
    request: APIRequestContext,
    matchText: string,
    responseTool: InteractiveToolResponse | InteractiveToolResponse[]
  ): Promise<void> {
    streamRuleMatchTexts.add(matchText)
    const response = await request.post(`${MOCK_MODEL_SERVER_URL}/stream-rules`, {
      ...MOCK_MODEL_CONTROL_REQUEST_OPTIONS,
      data: {
        matchText,
        ...(Array.isArray(responseTool) ? { responseTools: responseTool } : { responseTool }),
      },
    })
    expect(response.status()).toBe(200)
  }

  async function configureToolScenario(
    request: APIRequestContext,
    matchText: string,
    steps: Array<{
      toolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>
      responseContent?: string
    }>
  ): Promise<void> {
    toolScenarioMatchTexts.add(matchText)
    const response = await request.post(`${MOCK_MODEL_SERVER_URL}/tool-scenarios`, {
      ...MOCK_MODEL_CONTROL_REQUEST_OPTIONS,
      data: { matchText, steps },
    })
    expect(response.status()).toBe(200)
  }

  async function cleanupToolScenarios(request: APIRequestContext): Promise<void> {
    const matchTexts = [...toolScenarioMatchTexts]
    toolScenarioMatchTexts.clear()
    await Promise.all(
      matchTexts.map(matchText =>
        request
          .delete(
            `${MOCK_MODEL_SERVER_URL}/tool-scenarios?matchText=${encodeURIComponent(matchText)}`,
            MOCK_MODEL_CONTROL_REQUEST_OPTIONS
          )
          .catch(() => null)
      )
    )
  }

  async function resetMockMcp(request: APIRequestContext): Promise<void> {
    const response = await request.post(
      `${MOCK_MODEL_SERVER_URL}/mcp-control/reset`,
      MOCK_MODEL_CONTROL_REQUEST_OPTIONS
    )
    expect(response.status()).toBe(200)
  }

  async function getMockMcpCalls(request: APIRequestContext): Promise<
    Array<{
      name: string
      arguments: Record<string, unknown>
      isError: boolean
    }>
  > {
    const response = await request.get(
      `${MOCK_MODEL_SERVER_URL}/mcp-control/calls`,
      MOCK_MODEL_CONTROL_REQUEST_OPTIONS
    )
    expect(response.status()).toBe(200)
    return response.json()
  }

  function containsInteractiveFormAnswer(
    value: unknown,
    toolUseId: string,
    questionId: string,
    selectedValue: string
  ): boolean {
    if (Array.isArray(value)) {
      return value.some(item =>
        containsInteractiveFormAnswer(item, toolUseId, questionId, selectedValue)
      )
    }
    if (!value || typeof value !== 'object') {
      return false
    }

    const record = value as Record<string, unknown>
    if (
      record.type === 'tool_result' &&
      record.tool_use_id === toolUseId &&
      answerPayloadContainsSelection(record.content, questionId, selectedValue)
    ) {
      return true
    }
    return Object.values(record).some(item =>
      containsInteractiveFormAnswer(item, toolUseId, questionId, selectedValue)
    )
  }

  function requestOffersTool(value: unknown, nameIncludes: string): boolean {
    if (!value || typeof value !== 'object') {
      return false
    }
    const tools = (value as { tools?: unknown }).tools
    if (!Array.isArray(tools)) {
      return false
    }
    return tools.some(tool => {
      if (!tool || typeof tool !== 'object') {
        return false
      }
      const name = (tool as { name?: unknown }).name
      return typeof name === 'string' && name.includes(nameIncludes)
    })
  }

  function answerPayloadContainsSelection(
    value: unknown,
    questionId: string,
    selectedValue: string
  ): boolean {
    if (typeof value === 'string') {
      try {
        return answerPayloadContainsSelection(JSON.parse(value), questionId, selectedValue)
      } catch {
        return false
      }
    }
    if (Array.isArray(value)) {
      return value.some(item => answerPayloadContainsSelection(item, questionId, selectedValue))
    }
    if (!value || typeof value !== 'object') {
      return false
    }

    const record = value as Record<string, unknown>
    if (record[questionId] === selectedValue) {
      return true
    }
    return Object.values(record).some(item =>
      answerPayloadContainsSelection(item, questionId, selectedValue)
    )
  }

  async function cleanupStreamRules(request: APIRequestContext): Promise<void> {
    const rules = [...streamRuleMatchTexts]
    streamRuleMatchTexts.clear()
    await Promise.all(
      rules.map(matchText =>
        request
          .delete(
            `${MOCK_MODEL_SERVER_URL}/stream-rules?matchText=${encodeURIComponent(matchText)}`,
            MOCK_MODEL_CONTROL_REQUEST_OPTIONS
          )
          .catch(() => null)
      )
    )
  }

  // Seeds a real project through the product API so mention pagination runs
  // against the Backend, not a fixture.
  async function seedMentionProject(
    request: APIRequestContext,
    name: string
  ): Promise<{ id: number }> {
    const response = await request.post(`${API_BASE_URL}/api/projects`, {
      headers: authHeaders(),
      data: {
        name,
        description: 'E2E project for handoff mention pagination',
        client_origin: 'frontend',
      },
    })
    const body = await response.text()
    expect(response.status(), body).toBe(201)
    const project = JSON.parse(body) as { id?: number }
    expect(project.id, 'Project creation should return an id').toBeTruthy()
    createdProjectIds.add(project.id!)
    return { id: project.id! }
  }

  // The real create API also dispatches the first model turn. Project fixtures
  // must settle those executions before touching their mention sort order.
  async function seedMentionTask(
    request: APIRequestContext,
    input: { title: string; prompt: string; projectId?: number }
  ): Promise<number> {
    const response = await request.post(`${API_BASE_URL}/api/tasks/create`, {
      headers: authHeaders(),
      data: {
        title: input.title,
        prompt: input.prompt,
        team_id: chatShellTeam.id,
        task_type: 'chat',
        client_origin: 'frontend',
        ...(input.projectId ? { project_id: input.projectId } : {}),
      },
    })
    const body = await response.text()
    expect(response.status(), body).toBe(201)
    const task = JSON.parse(body) as { id?: number }
    expect(task.id, 'Seeded task should have an id').toBeTruthy()
    createdTaskIds.add(task.id!)
    return task.id!
  }

  // Creates the history sequentially so creation order stays predictable.
  async function seedMentionTasks(
    request: APIRequestContext,
    count: number,
    titleFor: (index: number) => string,
    projectId?: number
  ): Promise<number[]> {
    const taskIds: number[] = []
    for (let index = 0; index < count; index += 1) {
      const title = titleFor(index)
      taskIds.push(await seedMentionTask(request, { title, prompt: title, projectId }))
    }
    return taskIds
  }

  // Pins the title and makes project fixtures newest without changing their task page.
  async function touchMentionTask(
    request: APIRequestContext,
    taskId: number,
    title: string,
    project?: { id: number; taskIds: number[] }
  ): Promise<void> {
    let latestUpdatedSecond = 0
    if (project) {
      await settleMentionTasks([taskId, ...project.taskIds], fixtureId =>
        waitForBackendTerminal(request, fixtureId)
      )
      const response = await request.get(
        `${API_BASE_URL}/api/projects/${project.id}/tasks?limit=100`,
        { headers: authHeaders() }
      )
      const body = await response.text()
      expect(response.status(), body).toBe(200)
      const page = JSON.parse(body) as {
        items: { task_id: number; updated_at: string }[]
        has_more: boolean
      }
      expect(page.has_more, 'The fixture snapshot should contain every project task').toBe(false)
      expect(new Set(page.items.map(task => task.task_id))).toEqual(
        new Set([taskId, ...project.taskIds])
      )
      latestUpdatedSecond = Math.max(
        ...page.items.map(task => Math.floor(Date.parse(task.updated_at) / 1_000))
      )
      expect(Number.isFinite(latestUpdatedSecond), 'Project tasks need valid updated_at').toBe(true)
    }

    // Completion updates must settle first, and MySQL timestamps have second precision.
    await expect
      .poll(
        async () => {
          const response = await request.put(`${API_BASE_URL}/api/tasks/${taskId}`, {
            headers: authHeaders(),
            data: { title },
          })
          const body = await response.text()
          expect(response.status(), body).toBe(200)
          const task = JSON.parse(body) as { updated_at: string }
          return Math.floor(Date.parse(task.updated_at) / 1_000)
        },
        {
          message: 'Touched task should sort after all completed mention fixtures',
          timeout: 5_000,
        }
      )
      .toBeGreaterThan(latestUpdatedSecond)
  }

  async function openTaskPage(
    page: Page,
    path: string,
    teamId: number,
    mode: 'chat' | 'code' | 'task'
  ): Promise<void> {
    await configureTaskPagePreferences(page, teamId, mode)

    const separator = path.includes('?') ? '&' : '?'
    await page.goto(`${path}${separator}teamId=${teamId}`, { waitUntil: 'domcontentloaded' })
    await dismissOnboardingTour(page)
    await ensureMessageInputReady(page)
  }

  async function configureTaskPagePreferences(
    page: Page,
    teamId: number,
    mode: 'chat' | 'code' | 'task'
  ): Promise<void> {
    await page.addInitScript(
      ({ selectedTeamId, selectedMode }) => {
        localStorage.setItem('user_onboarding_completed', 'true')
        localStorage.setItem('hasSeenCodeTour', 'true')
        localStorage.setItem('task-sidebar-collapsed', 'false')
        localStorage.setItem('wegent_last_team_id', String(selectedTeamId))
        if (selectedMode === 'chat') {
          localStorage.setItem('wegent_last_team_id_chat', String(selectedTeamId))
        } else {
          localStorage.setItem('wegent_last_team_id_code', String(selectedTeamId))
        }
      },
      { selectedTeamId: teamId, selectedMode: mode }
    )
  }

  async function selectModel(page: Page, modelName: string): Promise<void> {
    const modelSelector = page.getByTestId('model-selector')
    await expect(modelSelector).toBeEnabled()
    await modelSelector.click()

    const modelSearch = page.getByTestId('model-cascade-search-input')
    await modelSearch.fill(modelName)
    const modelOption = page.getByTestId(`model-option-${modelName}`)
    await expect(modelOption).toBeVisible()
    await modelOption.click()

    await expect(modelSelector).toHaveAttribute('aria-expanded', 'false')
    await expect(modelSelector).toContainText(modelName)
  }

  async function sendMessage(page: Page, message: string): Promise<void> {
    await ensureMessageInputReady(page)
    const input = page.getByTestId('message-input')
    await input.fill(message)
    await expect(input).toContainText(message, { timeout: 10_000 })

    const sendButton = page.getByTestId('send-button')
    await expect(sendButton).toBeVisible({ timeout: 10_000 })
    await expect(sendButton).toBeEnabled({ timeout: 15_000 })
    await sendButton.click()
  }

  async function ensureMessageInputReady(page: Page): Promise<void> {
    const input = page.getByTestId('message-input')
    await expect(input).toBeVisible({ timeout: 20_000 })
    await expect(input).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 })
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 20_000 })
  }

  async function waitForTaskId(page: Page): Promise<number> {
    await expect
      .poll(() => new URL(page.url()).searchParams.get('taskId'), {
        message: 'URL should contain taskId after sending a message',
        timeout: 20_000,
      })
      .not.toBeNull()

    const taskId = Number(new URL(page.url()).searchParams.get('taskId'))
    expect(Number.isFinite(taskId)).toBe(true)
    return taskId
  }

  async function waitForBackendTerminal(request: APIRequestContext, taskId: number): Promise<void> {
    await expect
      .poll(
        async () => {
          try {
            const response = await request.get(
              `${API_BASE_URL}/api/tasks/${taskId}/runtime-check`,
              {
                headers: authHeaders(),
              }
            )
            if (response.status() !== 200) {
              return `HTTP_${response.status()}`
            }

            const runtime = (await response.json()) as RuntimeCheckResponse
            const status = String(runtime.task_status || '').toUpperCase()
            return ['COMPLETED', 'COMPLETED_SILENT', 'FAILED', 'CANCELLED'].includes(status)
              ? status
              : 'RUNNING'
          } catch (error) {
            return `NETWORK_ERROR_${error instanceof Error ? error.message : String(error)}`
          }
        },
        {
          message: `Task ${taskId} should reach a terminal status`,
          timeout: RESPONSE_TIMEOUT_MS,
        }
      )
      .toBe('COMPLETED')
  }

  async function waitForCapturedModelRequest(
    request: APIRequestContext,
    predicateOrText: string | ((capture: CapturedModelRequest) => boolean),
    label?: string
  ): Promise<CapturedModelRequest> {
    const predicate =
      typeof predicateOrText === 'string'
        ? (capture: CapturedModelRequest) =>
            capture.url.includes('/chat/completions') &&
            extractText(capture.body).includes(predicateOrText)
        : predicateOrText

    return waitForCapturedRequest<CapturedModelRequest>(
      () => loadCapturedModelRequests(request),
      predicate,
      label || `mock model request containing ${predicateOrText}`
    )
  }

  async function loadCapturedModelRequests(
    request: APIRequestContext
  ): Promise<CapturedModelRequest[]> {
    const response = await request.get(
      `${MOCK_MODEL_SERVER_URL}/captured-requests`,
      MOCK_MODEL_CONTROL_REQUEST_OPTIONS
    )
    expect(response.status()).toBe(200)
    return (await response.json()) as CapturedModelRequest[]
  }

  async function waitForCapturedRequest<T>(
    load: () => Promise<T[]>,
    predicate: (capture: T) => boolean,
    label: string
  ): Promise<T> {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS
    while (Date.now() < deadline) {
      const captures = await load()
      const match = captures.find(predicate)
      if (match) {
        return match
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }

  async function waitForWeworkDeviceOnline(request: APIRequestContext): Promise<void> {
    await expect
      .poll(
        async () => {
          const response = await request.get(`${API_BASE_URL}/api/devices`, {
            headers: authHeaders(),
          })
          if (response.status() !== 200) {
            return `HTTP_${response.status()}`
          }
          const body = (await response.json()) as {
            items?: Array<{
              device_id: string
              status: string
              bind_shell?: string
              device_type?: string
            }>
          }
          const device = body.items?.find(item => item.device_id === DEVICE_ID)
          return device
            ? `${device.status}:${device.bind_shell || ''}:${device.device_type || ''}`
            : 'missing'
        },
        {
          message: 'Wework app device should be online',
          timeout: 30_000,
        }
      )
      .toBe('online:claudecode:app')
  }

  async function expectServiceHealthy(
    request: APIRequestContext,
    url: string,
    label: string
  ): Promise<void> {
    const response = await request.get(url, MOCK_MODEL_CONTROL_REQUEST_OPTIONS)
    expect(response.status(), `${label} should be healthy`).toBe(200)
  }

  async function clearMockModelRequests(request: APIRequestContext): Promise<void> {
    await request
      .post(`${MOCK_MODEL_SERVER_URL}/clear-requests`, MOCK_MODEL_CONTROL_REQUEST_OPTIONS)
      .catch(() => null)
  }

  async function dismissOnboardingTour(page: Page): Promise<void> {
    const overlay = page.locator('.driver-overlay, .driver-popover')
    if (!(await overlay.isVisible({ timeout: 1000 }).catch(() => false))) {
      return
    }

    const closeButton = page
      .locator(
        '.driver-popover-close-btn, button:has-text("Skip"), button:has-text("跳过"), button:has-text("Done"), button:has-text("完成")'
      )
      .first()
    if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeButton.click()
      return
    }
    await page.keyboard.press('Escape')
  }

  function makeContextToken(scope: string): string {
    return `CTX_${scope}_${TEST_PREFIX}`.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  }

  function extractText(value: unknown): string {
    if (typeof value === 'string') {
      return value
    }

    if (Array.isArray(value)) {
      return value.map(item => extractText(item)).join(' ')
    }

    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>
      return ['body', 'messages', 'system', 'input', 'content', 'text', 'prompt']
        .map(key => extractText(obj[key]))
        .join(' ')
    }

    return ''
  }

  function isAnthropicMessagesRequest(capture: CapturedModelRequest): boolean {
    return capture.url.includes('/messages') && !capture.url.includes('/messages/count_tokens')
  }

  function isOpenAIResponsesRequest(capture: CapturedModelRequest): boolean {
    return capture.url.includes('/responses')
  }

  function requestContainsAll(capture: CapturedModelRequest, expectedTexts: string[]): boolean {
    const text = extractText(capture.body)
    return expectedTexts.every(expected => text.includes(expected))
  }

  function isPipelineTeam(team: CreatedTeam): team is CreatedPipelineTeam {
    return 'stageTwoBotName' in team
  }

  function authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }
})
