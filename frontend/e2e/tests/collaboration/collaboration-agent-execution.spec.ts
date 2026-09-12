// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { APIRequestContext, expect, Page, test, TestInfo } from '@playwright/test'
import {
  authHeaders,
  clearToolScenario,
  collectTaskToolCalls,
  configureToolScenario,
  createProviderNativeResources,
  deleteProviderNativeResources,
  extractTaskAnswer,
  getMcpCalls,
  getScenarioModelBodies,
  getTask,
  modelRequestText,
  modelToolNames,
  providerNativeMcpServer,
  PROVIDER_NATIVE_API_URL,
  PROVIDER_NATIVE_MOCK_URL,
  ProviderNativeResources,
  ProviderNativeSkillRef,
  resolveProviderNativeSkillRef,
  waitForTaskTerminal,
} from '../../utils/provider-native-test-support'

const TEST_PREFIX = `e2e-collaboration-agents-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`
const CLAUDE_MODEL_SERVER_URL = process.env.E2E_CLAUDE_MODEL_SERVER_URL || PROVIDER_NATIVE_MOCK_URL
const CLAUDE_EXECUTOR_IMAGE =
  process.env.E2E_CLAUDE_EXECUTOR_IMAGE || 'wegent/e2e-claudecode-executor:latest'
const SKILL_NAME = 'wegent-knowledge'
const SKILL_MARKER = '# Wegent Knowledge Base Skill'
const MCP_SERVER_NAME = 'collaboration-evidence'
const CLAUDE_ARTIFACT_NAME = 'collaboration-claudecode-runtime-evidence.txt'

interface VersionedResource {
  version: number
}

interface CollaborationWorkspace extends VersionedResource {
  id: string
}

interface CollaborationProject extends VersionedResource {
  id: string
}

interface CollaborationAgent {
  id: string
  name: string
  runtime: 'wegent'
  wegentTeamId: number
}

interface CollaborationIssue extends VersionedResource {
  id: string
  status: string
  assignee_agent_id: string | null
  execution_state: string | null
  ai_state: {
    status?: string
    agent_id?: string
    team_id?: number
    project_chat_message_id?: string
  } | null
}

interface CollaborationExecution {
  id: number
  loopItemId: string
  agentId: string | null
  teamId: number | null
  backendTaskId: number | null
  status: string
  displayState: string
  observedState: string
  syncState: string
}

interface BackendTaskSubtask {
  id: number
  role: string
  status: string
  executor_name: string | null
  executor_namespace: string | null
}

interface BackendTask {
  id: number
  model_id: string | null
  status: string
  execution_workspace_source: string | null
  execution_workspace_path: string | null
  subtasks: BackendTaskSubtask[]
}

interface RuntimeCheck {
  task_id: number
  task_status: string
  active_stream: unknown | null
}

interface RemoteWorkspaceStatus {
  connected: boolean
  available: boolean
  root_path: string
  reason: string | null
}

interface CreatedClaudeResources {
  modelName: string
  shellName: string
  botName: string
  teamName: string
  teamId: number
}

interface AgentCase {
  label: 'Chat' | 'ClaudeCode'
  teamId: number
  agent: CollaborationAgent
  loadsSkillWithTool: boolean
  prompt: string
  nodeId: string
  mcpOutputMarker: string
  answerMarker: string
  artifactName?: string
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({
    path,
    fullPage: true,
  })
  await testInfo.attach(name, {
    path,
    contentType: 'image/png',
  })
}

test.describe.configure({ mode: 'serial', timeout: 240_000 })

test.describe('Collaboration agent execution', () => {
  let resources: ProviderNativeResources
  let skillRef: ProviderNativeSkillRef
  let claude: CreatedClaudeResources
  let workspace: CollaborationWorkspace | null = null
  let project: CollaborationProject | null = null
  const configuredPrompts = new Set<string>()

  test.beforeAll(async ({ request }) => {
    resources = await createProviderNativeResources(request, TEST_PREFIX)
    skillRef = await resolveProviderNativeSkillRef(request, resources.token, SKILL_NAME)
    await configureBotCapabilities(request, resources.botId, skillRef)
    claude = await createClaudeResources(request, skillRef)
    workspace = await createWorkspace(request)
    project = await createProject(request, workspace.id)
    await addWorkspaceAgent(request, workspace.id, resources.teamId)
    await addWorkspaceAgent(request, workspace.id, claude.teamId)
  })

  test.afterAll(async ({ request }) => {
    for (const prompt of configuredPrompts) {
      await clearToolScenario(request, prompt).catch(() => null)
    }
    if (project) await archive(request, `/api/v1/cloud-projects/${project.id}`)
    if (workspace) await archive(request, `/api/v1/workspaces/${workspace.id}`)
    await cleanupClaudeResources(request, claude).catch(() => null)
    if (resources) await deleteProviderNativeResources(request, resources)
  })

  test('executes Chat and ClaudeCode project agents with Ghost Skill and MCP evidence', async ({
    page,
    request,
  }, testInfo) => {
    expect(project?.id).toBeTruthy()
    const projectId = project!.id
    const chatAgent = await createProjectAgent(
      request,
      projectId,
      'Chat collaboration agent',
      resources.teamId
    )
    const claudeAgent = await createProjectAgent(
      request,
      projectId,
      'ClaudeCode collaboration agent',
      claude.teamId
    )
    const cases: AgentCase[] = [
      {
        label: 'Chat',
        teamId: resources.teamId,
        agent: chatAgent,
        loadsSkillWithTool: false,
        prompt: `${TEST_PREFIX} CHAT_GHOST_CAPABILITY_EXECUTION`,
        nodeId: 'doc-d2',
        mcpOutputMarker: 'Doc-D2_旧设计',
        answerMarker: 'COLLABORATION_CHAT_COMPLETED',
      },
      {
        label: 'ClaudeCode',
        teamId: claude.teamId,
        agent: claudeAgent,
        loadsSkillWithTool: true,
        prompt: `${TEST_PREFIX} CLAUDE_GHOST_CAPABILITY_EXECUTION`,
        nodeId: 'doc-d3',
        mcpOutputMarker: 'Doc-D3_项目说明',
        answerMarker: 'COLLABORATION_CLAUDE_COMPLETED',
        artifactName: CLAUDE_ARTIFACT_NAME,
      },
    ]

    await page.goto(`/collaboration/workspaces/${workspace!.id}/projects/${projectId}`)
    await expect(page.getByTestId('cloud-project-header')).toBeVisible()
    await capture(page, testInfo, 'wegent-01-workspace-project-agents')

    for (const agentCase of cases) {
      await executeAndAssertCase(page, request, projectId, agentCase, testInfo)
    }
  })

  async function executeAndAssertCase(
    page: Page,
    request: APIRequestContext,
    projectId: string,
    agentCase: AgentCase,
    testInfo: TestInfo
  ): Promise<void> {
    const artifactContent = agentCase.artifactName
      ? [
          `SKILL_PROBE=${SKILL_MARKER}`,
          `MCP_PROBE=${agentCase.mcpOutputMarker}`,
          `TASK_RESULT=${agentCase.answerMarker}`,
        ].join('\n')
      : ''
    const artifactCommand = agentCase.artifactName
      ? [
          `cat > ${agentCase.artifactName} <<'EOF'`,
          artifactContent,
          'EOF',
          `cat ${agentCase.artifactName}`,
        ].join('\n')
      : ''
    const issue = await createIssue(request, projectId, agentCase)
    const scenarioMatch = `task_id: ${issue.id}`
    configuredPrompts.add(scenarioMatch)
    await configureToolScenario(request, scenarioMatch, [
      ...(agentCase.loadsSkillWithTool
        ? [
            {
              toolCalls: [
                {
                  toolName: 'Skill',
                  arguments: { skill: SKILL_NAME },
                },
              ],
            },
          ]
        : []),
      {
        toolCalls: [
          {
            toolName: 'get_document_info',
            arguments: { nodeId: agentCase.nodeId },
          },
        ],
      },
      ...(agentCase.artifactName
        ? [
            {
              toolCalls: [
                {
                  toolName: 'Bash',
                  arguments: {
                    command: artifactCommand,
                    description: 'Persist collaboration execution evidence',
                  },
                },
              ],
            },
          ]
        : []),
      {
        responseContent: [
          agentCase.answerMarker,
          SKILL_MARKER,
          agentCase.mcpOutputMarker,
          agentCase.artifactName ?? '',
        ]
          .filter(Boolean)
          .join(' '),
      },
    ])

    await page.goto(
      `/collaboration/workspaces/${workspace!.id}/projects/${projectId}/issues/${issue.id}`
    )
    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    await capture(page, testInfo, `wegent-${agentCase.label.toLowerCase()}-02-issue-created`)
    const assignmentComment = `Assign ${agentCase.label} through the collaboration execution path.`
    await page
      .getByTestId('collaboration-assignment-target')
      .selectOption({ label: agentCase.agent.name })
    await page
      .getByTestId('collaboration-assignment-workflow-step')
      .fill(`${agentCase.label} execution`)
    await page.getByTestId('collaboration-issue-comment').fill(assignmentComment)
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(assignmentComment)
    await capture(page, testInfo, `wegent-${agentCase.label.toLowerCase()}-03-assigned`)

    const execution = await waitForCompletedExecution(request, projectId, issue.id)
    expect(execution.agentId).toBe(agentCase.agent.id)
    expect(execution.teamId).toBe(agentCase.teamId)
    expect(execution.backendTaskId).toBeGreaterThan(0)
    expect(execution.observedState).toBe('succeeded')
    expect(execution.displayState).toBe('succeeded')
    expect(execution.syncState).toBe('in_sync')

    await waitForTaskTerminal(resources.token, execution.backendTaskId!)
    const task = (await getTask(request, resources.token, execution.backendTaskId!)) as BackendTask
    expect(task.id).toBe(execution.backendTaskId)
    expect(String(task.status).toUpperCase()).toMatch(/^COMPLETED/)
    const taskCalls = collectTaskToolCalls(task).filter(call =>
      call.name.endsWith('get_document_info')
    )
    expect(taskCalls).toHaveLength(1)
    expect(taskCalls[0].input).toEqual({ nodeId: agentCase.nodeId })
    expect(JSON.stringify(taskCalls[0].output)).toContain(agentCase.mcpOutputMarker)
    expect(extractTaskAnswer(task)).toContain(agentCase.answerMarker)
    expect(extractTaskAnswer(task)).toContain(SKILL_MARKER)
    expect(extractTaskAnswer(task)).toContain(agentCase.mcpOutputMarker)

    const modelBodies = await getScenarioModelBodies(request, scenarioMatch)
    expect(modelBodies.length).toBeGreaterThan(1)
    if (agentCase.loadsSkillWithTool) {
      const skillCalls = collectTaskToolCalls(task).filter(call => call.name === 'Skill')
      expect(skillCalls).toHaveLength(1)
      expect(skillCalls[0].input).toEqual({ skill: SKILL_NAME })
      expect(modelToolNames(modelBodies.slice(0, 1))).toContain('Skill')
      expect(modelRequestText(modelBodies.slice(0, 1))).toContain(SKILL_NAME)
      expect(modelRequestText(modelBodies.slice(1))).toContain(SKILL_MARKER)
    } else {
      expect(modelRequestText(modelBodies.slice(0, 1))).toContain(SKILL_MARKER)
    }
    expect(modelToolNames(modelBodies).some(name => name.endsWith('get_document_info'))).toBe(true)
    const mcpResultRequestIndex = agentCase.loadsSkillWithTool ? 2 : 1
    expect(modelRequestText(modelBodies.slice(mcpResultRequestIndex))).toContain(
      agentCase.mcpOutputMarker
    )

    if (agentCase.artifactName) {
      await assertClaudeRuntimeEvidence(
        request,
        execution,
        task,
        modelBodies,
        agentCase,
        artifactCommand,
        artifactContent
      )
    }

    const mcpCalls = (await getMcpCalls(request)).filter(
      call =>
        call.name === 'get_document_info' && String(call.arguments.nodeId) === agentCase.nodeId
    )
    expect(mcpCalls).toHaveLength(1)
    expect(mcpCalls[0]).toMatchObject({
      name: 'get_document_info',
      arguments: { nodeId: agentCase.nodeId },
      isError: false,
    })
    expect(JSON.stringify(mcpCalls[0].result)).toContain(agentCase.mcpOutputMarker)

    const completedIssue = await waitForCompletedIssue(request, issue.id)
    expect(completedIssue.status).toBe('in_review')
    expect(completedIssue.execution_state).toBe('succeeded')
    expect(completedIssue.ai_state).toMatchObject({
      status: 'succeeded',
      agent_id: agentCase.agent.id,
      team_id: agentCase.teamId,
    })
    expect(completedIssue.ai_state?.project_chat_message_id).toBeTruthy()

    await page.reload()
    await expect(page.getByTestId(`collaboration-run-${execution.id}`)).toContainText('succeeded')
    await capture(page, testInfo, `wegent-${agentCase.label.toLowerCase()}-04-completed`)
  }

  async function assertClaudeRuntimeEvidence(
    request: APIRequestContext,
    execution: CollaborationExecution,
    task: BackendTask,
    modelBodies: Record<string, unknown>[],
    agentCase: AgentCase,
    artifactCommand: string,
    artifactContent: string
  ): Promise<void> {
    expect(task.model_id).toBe(claude.modelName)
    const runtimeSubtask = task.subtasks.find(
      subtask =>
        String(subtask.role).toUpperCase() === 'ASSISTANT' &&
        Boolean(subtask.executor_name) &&
        Boolean(subtask.executor_namespace)
    )
    expect(runtimeSubtask, 'ClaudeCode task should retain its Executor identity').toBeTruthy()
    expect(runtimeSubtask!.id).toBeGreaterThan(0)
    expect(runtimeSubtask!.executor_name).toMatch(/^executor-/)
    expect(runtimeSubtask!.executor_namespace).toBeTruthy()
    expect(String(runtimeSubtask!.status).toUpperCase()).toMatch(/^COMPLETED/)

    const runtime = await apiRequest<RuntimeCheck>(
      request,
      `/api/tasks/${execution.backendTaskId}/runtime-check`
    )
    expect(runtime).toMatchObject({
      task_id: execution.backendTaskId,
      active_stream: null,
    })
    expect(String(runtime.task_status).toUpperCase()).toMatch(/^COMPLETED/)

    const bashCalls = collectTaskToolCalls(task).filter(call => call.name === 'Bash')
    expect(bashCalls).toHaveLength(1)
    expect(bashCalls[0].input).toEqual({
      command: artifactCommand,
      description: 'Persist collaboration execution evidence',
    })
    expect(modelToolNames(modelBodies).some(name => name === 'Bash')).toBe(true)
    expect(modelRequestText(modelBodies.slice(2))).toContain(SKILL_MARKER)
    expect(modelRequestText(modelBodies.slice(2))).toContain(agentCase.mcpOutputMarker)

    const workspace = await apiRequest<RemoteWorkspaceStatus>(
      request,
      `/api/tasks/${execution.backendTaskId}/remote-workspace/status`
    )
    expect(workspace).toMatchObject({
      connected: true,
      available: true,
      reason: null,
    })
    expect(workspace.root_path).toBeTruthy()
    if (task.execution_workspace_path) {
      expect(workspace.root_path).toBe(task.execution_workspace_path)
    }

    const artifactPath = `${workspace.root_path.replace(/\/$/, '')}/${agentCase.artifactName}`
    const artifactResponse = await request.get(
      `${PROVIDER_NATIVE_API_URL}/api/tasks/${
        execution.backendTaskId
      }/remote-workspace/file?path=${encodeURIComponent(artifactPath)}&disposition=inline`,
      { headers: authHeaders(resources.token) }
    )
    const artifactBody = await artifactResponse.text()
    expect(artifactResponse.status(), artifactBody).toBe(200)
    expect(artifactBody.trim()).toBe(artifactContent)
    expect(extractTaskAnswer(task)).toContain(agentCase.artifactName!)
  }

  async function configureBotCapabilities(
    request: APIRequestContext,
    botId: number,
    ref: ProviderNativeSkillRef
  ): Promise<void> {
    await apiRequest(request, `/api/bots/${botId}`, {
      method: 'PUT',
      data: {
        skills: [SKILL_NAME],
        skill_refs: { [SKILL_NAME]: ref },
        preload_skills: [SKILL_NAME],
        preload_skill_refs: { [SKILL_NAME]: ref },
        mcp_servers: {
          [MCP_SERVER_NAME]: providerNativeMcpServer(),
        },
      },
    })
  }

  async function createClaudeResources(
    request: APIRequestContext,
    ref: ProviderNativeSkillRef
  ): Promise<CreatedClaudeResources> {
    const modelName = `${TEST_PREFIX}-claude-model`
    const shellName = `${TEST_PREFIX}-claude-shell`
    const botName = `${TEST_PREFIX}-claude-bot`
    const teamName = `${TEST_PREFIX}-claude-team`
    await apiRequest(request, '/api/v1/namespaces/default/models', {
      method: 'POST',
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: { name: modelName, namespace: 'default' },
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
    })
    await apiRequest(request, '/api/shells', {
      method: 'POST',
      data: {
        name: shellName,
        displayName: 'Collaboration E2E ClaudeCode',
        baseShellRef: 'ClaudeCode',
        baseImage: CLAUDE_EXECUTOR_IMAGE,
      },
    })
    const bot = await apiRequest<{ id: number }>(request, '/api/bots', {
      method: 'POST',
      data: {
        name: botName,
        shell_name: shellName,
        agent_config: { bind_model: modelName, bind_model_type: 'user' },
        system_prompt: 'Complete the assigned collaboration Issue deterministically.',
        skills: [SKILL_NAME],
        skill_refs: { [SKILL_NAME]: ref },
        preload_skills: [SKILL_NAME],
        preload_skill_refs: { [SKILL_NAME]: ref },
        mcp_servers: {
          [MCP_SERVER_NAME]: providerNativeMcpServer(),
        },
        namespace: 'default',
        is_active: true,
      },
    })
    const team = await apiRequest<{ id: number }>(request, '/api/teams', {
      method: 'POST',
      data: {
        name: teamName,
        description: 'ClaudeCode collaboration execution E2E team',
        bots: [{ bot_id: bot.id, bot_prompt: '', role: 'worker' }],
        bind_mode: ['chat'],
        namespace: 'default',
        is_active: true,
        requires_workspace: false,
      },
    })
    return { modelName, shellName, botName, teamName, teamId: team.id }
  }

  async function cleanupClaudeResources(
    request: APIRequestContext,
    created: CreatedClaudeResources
  ): Promise<void> {
    for (const [kind, name] of [
      ['teams', created.teamName],
      ['bots', created.botName],
      ['models', created.modelName],
    ]) {
      await request.delete(`${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/${kind}/${name}`, {
        headers: authHeaders(resources.token),
      })
    }
    await request.delete(`${PROVIDER_NATIVE_API_URL}/api/shells/${created.shellName}`, {
      headers: authHeaders(resources.token),
    })
  }

  async function createWorkspace(request: APIRequestContext): Promise<CollaborationWorkspace> {
    return apiRequest(request, '/api/v1/workspaces', {
      method: 'POST',
      data: {
        name: `${TEST_PREFIX} workspace`,
        description: 'Real Workspace for collaboration agent execution E2E.',
      },
    })
  }

  async function createProject(
    request: APIRequestContext,
    workspaceId: string
  ): Promise<CollaborationProject> {
    return apiRequest(request, `/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      data: {
        name: `${TEST_PREFIX} project`,
        description: 'Real Project for collaboration agent execution E2E.',
        task_provider: 'local',
        visibility: 'private',
      },
    })
  }

  async function addWorkspaceAgent(
    request: APIRequestContext,
    workspaceId: string,
    teamId: number
  ): Promise<void> {
    await apiRequest(request, `/api/v1/workspaces/${workspaceId}/agents`, {
      method: 'POST',
      data: { team_id: teamId },
    })
  }

  async function createProjectAgent(
    request: APIRequestContext,
    projectId: string,
    name: string,
    teamId: number
  ): Promise<CollaborationAgent> {
    return apiRequest(request, `/api/v1/cloud-projects/${projectId}/chat-agents`, {
      method: 'POST',
      data: {
        name,
        runtime: 'wegent',
        wegentTeamId: teamId,
        capabilityDescription: `${name} with preloaded Skill and Ghost MCP.`,
        visibility: 'creator_admin',
        executionMode: 'auto',
      },
    })
  }

  async function createIssue(
    request: APIRequestContext,
    projectId: string,
    agentCase: AgentCase
  ): Promise<CollaborationIssue> {
    return apiRequest(request, `/api/v1/cloud-projects/${projectId}/loop-items`, {
      method: 'POST',
      data: {
        title: `${agentCase.label} capability execution`,
        description: [
          agentCase.prompt,
          `Call get_document_info with nodeId ${agentCase.nodeId}.`,
          `Use the preloaded ${SKILL_NAME} Skill and finish with ${agentCase.answerMarker}.`,
        ].join('\n'),
        status: 'pending',
        priority: 'high',
        tags: ['collaboration-e2e', agentCase.label.toLowerCase()],
      },
    })
  }

  async function waitForCompletedExecution(
    request: APIRequestContext,
    projectId: string,
    issueId: string
  ): Promise<CollaborationExecution> {
    let completed: CollaborationExecution | undefined
    await expect
      .poll(
        async () => {
          const response = await apiRequest<{ items: CollaborationExecution[] }>(
            request,
            `/api/v1/cloud-projects/${projectId}/executions?status=completed`
          )
          completed = response.items.find(item => item.loopItemId === issueId)
          return completed?.status ?? 'missing'
        },
        {
          timeout: 180_000,
          message: `Execution for Issue ${issueId} should complete`,
        }
      )
      .toBe('completed')
    return completed!
  }

  async function waitForCompletedIssue(
    request: APIRequestContext,
    issueId: string
  ): Promise<CollaborationIssue> {
    let issue: CollaborationIssue | undefined
    await expect
      .poll(
        async () => {
          issue = await apiRequest<CollaborationIssue>(request, `/api/v1/loop-items/${issueId}`)
          return {
            status: issue.status,
            executionState: issue.execution_state,
            aiStatus: issue.ai_state?.status,
          }
        },
        {
          timeout: 30_000,
          message: `Issue ${issueId} should project the completed AI run`,
        }
      )
      .toEqual({
        status: 'in_review',
        executionState: 'succeeded',
        aiStatus: 'succeeded',
      })
    return issue!
  }

  async function archive(request: APIRequestContext, pathname: string): Promise<void> {
    const current = await apiRequest<VersionedResource>(request, pathname)
    const response = await request.delete(
      `${PROVIDER_NATIVE_API_URL}${pathname}?version=${current.version}`,
      { headers: authHeaders(resources.token) }
    )
    expect(response.status(), await response.text()).toBe(204)
  }

  async function apiRequest<T = unknown>(
    request: APIRequestContext,
    pathname: string,
    options: { method?: 'GET' | 'POST' | 'PUT'; data?: unknown } = {}
  ): Promise<T> {
    const response = await request.fetch(`${PROVIDER_NATIVE_API_URL}${pathname}`, {
      method: options.method ?? 'GET',
      headers: authHeaders(resources.token),
      data: options.data,
    })
    expect(
      response.ok(),
      `${options.method ?? 'GET'} ${pathname}: ${response.status()} ${await response.text()}`
    ).toBe(true)
    return (await response.json()) as T
  }
})
