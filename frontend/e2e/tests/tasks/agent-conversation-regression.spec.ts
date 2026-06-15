/**
 * Agent conversation regression tests for CI.
 *
 * These tests use the real frontend, backend, Socket.IO, Chat Shell, and
 * backend execution routing. CI uses:
 * - mock-model-server for Chat Shell and ClaudeCode model requests
 * - real executor-manager plus a real ClaudeCode executor image for ClaudeCode HTTP tasks
 * - real local executor in local mode for device WebSocket tasks
 */

import { APIRequestContext, Page, expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { ApiClient, createApiClient } from '../../utils/api-client'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const MOCK_MODEL_SERVER_URL = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const CLAUDE_MODEL_SERVER_URL = process.env.E2E_CLAUDE_MODEL_SERVER_URL || MOCK_MODEL_SERVER_URL
const LOCAL_CLAUDE_MODEL_SERVER_URL =
  process.env.E2E_LOCAL_CLAUDE_MODEL_SERVER_URL || MOCK_MODEL_SERVER_URL
const DEVICE_ID = process.env.E2E_DEVICE_ID || 'e2e-claudecode-device'
const TEST_PREFIX = `e2e-agent-reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const CHAT_MODEL_NAME = `${TEST_PREFIX}-chat-model`
const CLAUDE_MODEL_NAME = `${TEST_PREFIX}-claude-model`
const DEVICE_CLAUDE_MODEL_NAME = `${TEST_PREFIX}-device-claude-model`
const CLAUDE_SHELL_NAME = `${TEST_PREFIX}-claude-shell`
const CLAUDE_EXECUTOR_IMAGE =
  process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const RESPONSE_TIMEOUT_MS = 120_000

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

test.describe.configure({ mode: 'serial', timeout: 180_000 })

test.describe('Agent conversation regression', () => {
  let apiClient: ApiClient
  let token = ''
  let chatShellTeam: CreatedTeam
  let claudeChatTeam: CreatedTeam
  let codeTeam: CreatedTeam
  let deviceTeam: CreatedTeam
  let manualPipelineTeam: CreatedPipelineTeam
  let automaticPipelineTeam: CreatedPipelineTeam
  const createdTaskIds = new Set<number>()
  const streamRuleMatchTexts = new Set<string>()

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
    await clearMockModelRequests(request)
    await cleanupCreatedTasks(request)
  })

  test.afterAll(async ({ request }) => {
    await cleanupCreatedTasks(request)
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

  test('coding mode ClaudeCode supports dialogue and follow-up', async ({ page, request }) => {
    const contextToken = makeContextToken('code')
    const firstPrompt = `Remember this code context token: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous code turn?'

    await openTaskPage(page, '/code', codeTeam.id, 'code')

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

  test('device mode ClaudeCode supports dialogue and follow-up', async ({ page, request }) => {
    const contextToken = makeContextToken('device')
    const firstPrompt = `Remember this device context token: ${contextToken}`
    const followUpPrompt = 'What context token did I provide in the previous device turn?'

    await waitForLocalDeviceOnline(request)
    await openTaskPage(page, `/devices/chat?deviceId=${DEVICE_ID}`, deviceTeam.id, 'task')

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
      `local ClaudeCode model request containing ${followUpPrompt}`
    )
    expect(extractText(secondRequest.body)).toContain(contextToken)
    expect(extractText(secondRequest.body)).toContain(firstPrompt)
  })

  test('manual pipeline next step sends handoff user message and next bot prompt to the second model', async ({
    page,
    request,
  }) => {
    const firstPrompt = `MANUAL_PIPELINE_USER_MESSAGE_${makeContextToken('manual_pipeline')}`
    const stageOneOutput = `MANUAL_PIPELINE_STAGE_ONE_OUTPUT_${makeContextToken('manual_stage')}`
    const expectedHandoff = `Previous pipeline context:\n\n[AI]\n${stageOneOutput}`

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

    await createClaudeShell(request)

    chatShellTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-chat-shell-team`,
      botName: `${TEST_PREFIX}-chat-shell-bot`,
      shellName: 'Chat',
      bindMode: ['chat'],
      modelName: CHAT_MODEL_NAME,
    })
    claudeChatTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-claude-chat-team`,
      botName: `${TEST_PREFIX}-claude-chat-bot`,
      shellName: CLAUDE_SHELL_NAME,
      bindMode: ['chat'],
      modelName: CLAUDE_MODEL_NAME,
    })
    codeTeam = await createTeam(request, {
      teamName: `${TEST_PREFIX}-code-team`,
      botName: `${TEST_PREFIX}-code-bot`,
      shellName: CLAUDE_SHELL_NAME,
      bindMode: ['code'],
      modelName: CLAUDE_MODEL_NAME,
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

  async function createClaudeShell(request: APIRequestContext): Promise<void> {
    const response = await request.post(`${API_BASE_URL}/api/shells`, {
      headers: authHeaders(),
      data: {
        name: CLAUDE_SHELL_NAME,
        displayName: 'E2E ClaudeCode Executor',
        baseShellRef: 'ClaudeCode',
        baseImage: CLAUDE_EXECUTOR_IMAGE,
      },
    })
    expect([200, 201]).toContain(response.status())
  }

  async function createTeam(
    request: APIRequestContext,
    options: {
      teamName: string
      botName: string
      shellName: string
      bindMode: string[]
      modelName: string
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
        system_prompt: 'You are a deterministic E2E regression assistant.',
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
      codeTeam,
      claudeChatTeam,
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

    for (const modelName of [DEVICE_CLAUDE_MODEL_NAME, CLAUDE_MODEL_NAME, CHAT_MODEL_NAME]) {
      await request
        .delete(`${API_BASE_URL}/api/v1/namespaces/default/models/${modelName}`, {
          headers: authHeaders(),
        })
        .catch(() => null)
    }

    await request
      .delete(`${API_BASE_URL}/api/shells/${CLAUDE_SHELL_NAME}`, {
        headers: authHeaders(),
      })
      .catch(() => null)
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

  async function configureStreamRule(
    request: APIRequestContext,
    matchText: string,
    responseContent: string
  ): Promise<void> {
    streamRuleMatchTexts.add(matchText)
    const response = await request.post(`${MOCK_MODEL_SERVER_URL}/stream-rules`, {
      data: {
        matchText,
        responseContent,
        chunkDelayMs: 20,
      },
    })
    expect(response.status()).toBe(200)
  }

  async function cleanupStreamRules(request: APIRequestContext): Promise<void> {
    const rules = [...streamRuleMatchTexts]
    streamRuleMatchTexts.clear()
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

  async function openTaskPage(
    page: Page,
    path: string,
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

    const separator = path.includes('?') ? '&' : '?'
    await page.goto(`${path}${separator}teamId=${teamId}`)
    await page.waitForLoadState('domcontentloaded')
    await dismissOnboardingTour(page)
    await ensureMessageInputReady(page)
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
          const response = await request.get(`${API_BASE_URL}/api/tasks/${taskId}/runtime-check`, {
            headers: authHeaders(),
          })
          if (response.status() !== 200) {
            return `HTTP_${response.status()}`
          }

          const runtime = (await response.json()) as RuntimeCheckResponse
          const status = String(runtime.task_status || '').toUpperCase()
          return ['COMPLETED', 'COMPLETED_SILENT', 'FAILED', 'CANCELLED'].includes(status)
            ? status
            : 'RUNNING'
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
      async () => {
        const response = await request.get(`${MOCK_MODEL_SERVER_URL}/captured-requests`)
        expect(response.status()).toBe(200)
        return (await response.json()) as CapturedModelRequest[]
      },
      predicate,
      label || `mock model request containing ${predicateOrText}`
    )
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

  async function waitForLocalDeviceOnline(request: APIRequestContext): Promise<void> {
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
            items?: Array<{ device_id: string; status: string; bind_shell?: string }>
          }
          const device = body.items?.find(item => item.device_id === DEVICE_ID)
          return device ? `${device.status}:${device.bind_shell || ''}` : 'missing'
        },
        {
          message: 'Local ClaudeCode executor device should be online',
          timeout: 30_000,
        }
      )
      .toBe('online:claudecode')
  }

  async function expectServiceHealthy(
    request: APIRequestContext,
    url: string,
    label: string
  ): Promise<void> {
    const response = await request.get(url)
    expect(response.status(), `${label} should be healthy`).toBe(200)
  }

  async function clearMockModelRequests(request: APIRequestContext): Promise<void> {
    await request.post(`${MOCK_MODEL_SERVER_URL}/clear-requests`).catch(() => null)
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
