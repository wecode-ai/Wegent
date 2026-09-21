// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { APIRequestContext, expect, Page, test, TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  authHeaders,
  clearToolScenario,
  configureToolScenario,
  createProviderNativeResources,
  deleteProviderNativeResources,
  getMcpCalls,
  getScenarioModelBodies,
  modelRequestText,
  modelToolNames,
  providerNativeMcpServer,
  PROVIDER_NATIVE_API_URL,
  ProviderNativeResources,
  ProviderNativeSkillRef,
  resolveProviderNativeSkillRef,
} from '../../utils/provider-native-test-support'

const TEST_PREFIX = `e2e-collaboration-agents-${Date.now()}-${Math.random()
  .toString(36)
  .slice(2, 8)}`
const SKILL_NAME = 'wegent-knowledge'
const SKILL_MARKER = '# Wegent Knowledge Base Skill'
const MCP_SERVER_NAME = 'collaboration-evidence'
const PLUGIN_NAME = `${TEST_PREFIX}-plugin`
const PLUGIN_MARKER = 'COLLABORATION_AGENT_REAL_PLUGIN'
const DEVICE_ID = process.env.E2E_DEVICE_ID || 'e2e-claudecode-device'
const execFileAsync = promisify(execFile)
const CREATE_ZIP_SCRIPT = `
from pathlib import Path
import sys
import zipfile

archive = Path(sys.argv[1])
source = Path(sys.argv[2])
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
    for path in sorted(source.rglob("*")):
        if path.is_file():
            output.write(path, path.relative_to(source))
`

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
  executionEnvironment: string | null
  executionDeviceId: string | null
  runtimeDeviceId: string | null
  runtimeTaskId: string | null
  status: string
  displayState: string
  observedState: string
  syncState: string
}

interface AgentCase {
  agent: CollaborationAgent
  prompt: string
  nodeId: string
  mcpOutputMarker: string
  answerMarker: string
}

interface CollaborationPlugin {
  id: string
  installedId: number
  pluginName: string
  marketplaceId: string
  displayName: string
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
  let plugin: CollaborationPlugin
  let workspace: CollaborationWorkspace | null = null
  let project: CollaborationProject | null = null
  const configuredPrompts = new Set<string>()

  test.beforeAll(async ({ request }) => {
    resources = await createProviderNativeResources(request, TEST_PREFIX)
    skillRef = await resolveProviderNativeSkillRef(request, resources.token, SKILL_NAME)
    plugin = await publishAndInstallPlugin(request)
    workspace = await createWorkspace(request)
    project = await createProject(request, workspace.id)
  })

  test.afterAll(async ({ request }) => {
    for (const prompt of configuredPrompts) {
      await clearToolScenario(request, prompt).catch(() => null)
    }
    if (project) await archive(request, `/api/v1/cloud-projects/${project.id}`)
    if (workspace) await archive(request, `/api/v1/workspaces/${workspace.id}`)
    if (plugin) {
      await request
        .delete(`${PROVIDER_NATIVE_API_URL}/api/plugins/installed/${plugin.installedId}`, {
          headers: authHeaders(resources.token),
        })
        .catch(() => null)
    }
    if (resources) await deleteProviderNativeResources(request, resources)
  })

  test('creates and runs a Wegent agent with Skill, plugin, and MCP evidence', async ({
    page,
    request,
  }, testInfo) => {
    expect(project?.id).toBeTruthy()
    const projectId = project!.id
    const agent = await createProjectAgentThroughUi(page, request, projectId)
    const agentCase: AgentCase = {
      agent,
      prompt: `${TEST_PREFIX} WEGENT_AGENT_CAPABILITY_EXECUTION`,
      nodeId: 'doc-d1',
      mcpOutputMarker: 'Doc-D1_新设计',
      answerMarker: 'COLLABORATION_WEGENT_COMPLETED',
    }

    await page.goto(`/collaboration/workspaces/${workspace!.id}/projects/${projectId}`)
    await expect(page.getByTestId('cloud-project-header')).toBeVisible()
    await capture(page, testInfo, 'wegent-01-workspace-project-agents')
    await executeAndAssertCase(page, request, projectId, agentCase, testInfo)
  })

  async function executeAndAssertCase(
    page: Page,
    request: APIRequestContext,
    projectId: string,
    agentCase: AgentCase,
    testInfo: TestInfo
  ): Promise<void> {
    const runtimeCapabilityCommand = [
      `cat .codex/skills/${SKILL_NAME}/SKILL.md`,
      `plugin_skill="$(find "$WEGENT_EXECUTOR_HOME/capabilities/store/plugins" -type f -path '*/skills/${PLUGIN_NAME}/SKILL.md' -print -quit)"`,
      'test -n "$plugin_skill"',
      'cat "$plugin_skill"',
    ].join('\n')
    const issue = await createIssue(request, projectId, agentCase)
    const scenarioMatch = `task_id: ${issue.id}`
    configuredPrompts.add(scenarioMatch)
    await configureToolScenario(request, scenarioMatch, [
      {
        toolCalls: [
          {
            toolName: 'exec_command',
            arguments: { cmd: runtimeCapabilityCommand },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: 'get_document_info',
            arguments: { nodeId: agentCase.nodeId },
          },
        ],
      },
      {
        responseContent: [agentCase.answerMarker, SKILL_MARKER, agentCase.mcpOutputMarker].join(
          ' '
        ),
      },
    ])

    await page.goto(
      `/collaboration/workspaces/${workspace!.id}/projects/${projectId}/issues/${issue.id}`
    )
    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    await capture(page, testInfo, 'wegent-02-issue-created')
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId(`cloud-todo-detail-assignee-option-agent:${agentCase.agent.id}`).click()
    await page.getByTestId('cloud-todo-save').click()
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `agent:${agentCase.agent.id}`
    )
    const assignedIssue = await apiRequest<CollaborationIssue>(
      request,
      `/api/v1/loop-items/${issue.id}`
    )
    expect(assignedIssue.assignee_agent_id).toBe(agentCase.agent.id)
    await capture(page, testInfo, 'wegent-03-assigned')

    const execution = await waitForCompletedExecution(request, projectId, issue.id)
    expect(execution.agentId).toBe(agentCase.agent.id)
    expect(execution.observedState).toBe('succeeded')
    expect(execution.displayState).toBe('succeeded')
    expect(execution.syncState).toBe('in_sync')
    expect(execution.teamId).toBeNull()
    expect(execution.backendTaskId).toBeNull()
    expect(execution.executionEnvironment).toBe('cloud')
    expect(execution.executionDeviceId).toBeTruthy()
    expect(execution.runtimeDeviceId).toBe(execution.executionDeviceId)
    expect(execution.runtimeTaskId).toMatch(/^codex-queue-\d+$/)

    const modelBodies = await getScenarioModelBodies(request, scenarioMatch)
    expect(modelBodies.length).toBeGreaterThan(1)
    expect(modelToolNames(modelBodies.slice(0, 1))).toContain('exec_command')
    expect(modelRequestText(modelBodies.slice(1))).toContain(SKILL_MARKER)
    expect(modelRequestText(modelBodies.slice(1))).toContain(PLUGIN_MARKER)
    expect(modelToolNames(modelBodies).some(name => name.endsWith('get_document_info'))).toBe(true)
    expect(modelRequestText(modelBodies)).toContain(PLUGIN_NAME)
    expect(modelRequestText(modelBodies)).toContain(PLUGIN_MARKER)
    expect(modelRequestText(modelBodies.slice(2))).toContain(agentCase.mcpOutputMarker)

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
    })
    expect(completedIssue.ai_state?.project_chat_message_id).toBeTruthy()

    await page.reload()
    const executionStatus = page
      .getByTestId(`task-activity-run-event-${completedIssue.ai_state!.project_chat_message_id}`)
      .getByRole('button', { name: 'Completed', exact: true })
    await expect(executionStatus).toHaveAttribute('data-status', 'succeeded')
    await expect(executionStatus).toContainText('Completed')
    await capture(page, testInfo, 'wegent-04-completed')
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

  async function publishAndInstallPlugin(request: APIRequestContext): Promise<CollaborationPlugin> {
    const root = await mkdtemp(join(tmpdir(), 'wegent-agent-plugin-'))
    const archivePath = `${root}.zip`
    try {
      const manifestRoot = join(root, '.codex-plugin')
      const pluginSkillRoot = join(root, 'skills', PLUGIN_NAME)
      await Promise.all([
        mkdir(manifestRoot, { recursive: true }),
        mkdir(pluginSkillRoot, { recursive: true }),
      ])
      await writeFile(
        join(manifestRoot, 'plugin.json'),
        `${JSON.stringify(
          {
            name: PLUGIN_NAME,
            displayName: 'Collaboration Agent E2E Plugin',
            description: `Real Agent plugin containing ${PLUGIN_MARKER}.`,
            version: '1.0.0',
            skills: './skills/',
            interface: {
              displayName: 'Collaboration Agent E2E Plugin',
              shortDescription: `Validates ${PLUGIN_MARKER}.`,
            },
          },
          null,
          2
        )}\n`
      )
      await writeFile(
        join(pluginSkillRoot, 'SKILL.md'),
        [
          '---',
          `name: ${PLUGIN_NAME}`,
          'description: Real collaboration Agent plugin Skill.',
          '---',
          '',
          `Preserve ${PLUGIN_MARKER} in the model context.`,
          '',
        ].join('\n')
      )
      await execFileAsync('python3', ['-c', CREATE_ZIP_SCRIPT, archivePath, root])
      const archive = await readFile(archivePath)
      const initializedResponse = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/plugins/submissions/init`,
        {
          headers: authHeaders(resources.token),
          data: {
            slug: PLUGIN_NAME,
            displayName: 'Collaboration Agent E2E Plugin',
            version: '1.0.0',
            filename: `${PLUGIN_NAME}.zip`,
            sha256: createHash('sha256').update(archive).digest('hex'),
            sizeBytes: archive.byteLength,
            listingType: 'plugin',
            purpose: 'restricted_share',
            visibility: 'personal',
          },
        }
      )
      const initializedBody = await initializedResponse.text()
      expect(initializedResponse.status(), initializedBody).toBe(201)
      const initialized = JSON.parse(initializedBody) as {
        submissionId: number
        pluginId: number
        uploadUrl: string
      }
      const uploadResponse = await request.put(
        new URL(initialized.uploadUrl, PROVIDER_NATIVE_API_URL).toString(),
        {
          headers: { 'Content-Type': 'application/zip' },
          data: archive,
        }
      )
      expect(uploadResponse.status(), await uploadResponse.text()).toBe(204)
      const completedResponse = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/plugins/submissions/${initialized.submissionId}/complete`,
        {
          headers: authHeaders(resources.token),
        }
      )
      const completedBody = await completedResponse.text()
      expect(completedResponse.status(), completedBody).toBe(200)
      const completed = JSON.parse(completedBody) as {
        submission: { status: string; pluginId: number }
      }
      expect(completed.submission).toMatchObject({
        status: 'approved',
        pluginId: initialized.pluginId,
      })
      const installResponse = await request.post(
        `${PROVIDER_NATIVE_API_URL}/api/plugins/marketplace/${
          initialized.pluginId
        }/install?device_id=${encodeURIComponent(DEVICE_ID)}`,
        {
          headers: authHeaders(resources.token),
        }
      )
      const installBody = await installResponse.text()
      expect(installResponse.status(), installBody).toBe(200)
      const installed = JSON.parse(installBody) as {
        plugin?: {
          metadata?: { labels?: { id?: string } }
          spec?: {
            displayName?: string
            source?: {
              pluginKey?: string
              marketplace?: string
              providerKey?: string
              catalogItemId?: string
            }
          }
        }
        sync?: { success?: boolean }
      }
      expect(installed.sync?.success).toBe(true)
      const installedId = Number(installed.plugin?.metadata?.labels?.id)
      const pluginName = installed.plugin?.spec?.source?.pluginKey
      const marketplaceId =
        installed.plugin?.spec?.source?.marketplace ||
        installed.plugin?.spec?.source?.providerKey ||
        installed.plugin?.spec?.source?.catalogItemId
      expect(installedId).toBeGreaterThan(0)
      expect(pluginName).toBe(PLUGIN_NAME)
      expect(marketplaceId).toBeTruthy()
      return {
        id: `${pluginName}@${marketplaceId}`,
        installedId,
        pluginName: pluginName!,
        marketplaceId: marketplaceId!,
        displayName: installed.plugin?.spec?.displayName || PLUGIN_NAME,
      }
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(archivePath, { force: true }),
      ])
    }
  }

  async function createProjectAgentThroughUi(
    page: Page,
    request: APIRequestContext,
    projectId: string
  ): Promise<CollaborationAgent> {
    const displayName = 'Wegent capability agent'
    await page.goto(`/collaboration/workspaces/${workspace!.id}/projects/${projectId}`)
    await page.getByTestId('collaboration-tab-manage').click()
    await page.getByTestId('collaboration-project-settings-participants').click()
    await page.getByTestId('collaboration-participants-tab-agents').click()
    await expect(page.getByTestId('project-agent-config')).toBeVisible()
    await page.getByTestId('project-agent-add').click()
    await page.getByTestId('project-agent-mode-create').click()
    await expect(page.getByTestId('web-agent-resource-creator')).toBeVisible()
    await page.getByTestId('web-agent-display-name').fill(displayName)
    await page.getByTestId('web-agent-model').selectOption({
      label: resources.modelName,
    })
    await page.getByTestId('web-agent-resource-creator-advanced-toggle').click()
    await page.getByTestId('web-agent-capability-mode-manual').click()
    await page.getByTestId('web-agent-skills-add').click()
    await page.getByTestId(`web-agent-skill-${skillRef.skill_id}`).click()
    await page.getByTestId('web-agent-plugins-add').click()
    await page.getByTestId(`web-agent-plugin-${plugin.id}`).click()
    await page
      .getByTestId('web-agent-system-prompt')
      .fill(
        [
          'Execute the assigned collaboration Issue deterministically.',
          `[$${PLUGIN_NAME}](plugin://${plugin.id})`,
          'Use the configured Skill and plugin before completing the Issue.',
        ].join(' ')
      )
    await page
      .getByTestId('web-agent-mcp')
      .fill(JSON.stringify({ [MCP_SERVER_NAME]: providerNativeMcpServer() }))
    await capture(page, test.info(), 'wegent-00-agent-capabilities-selected')
    await page.getByTestId('web-agent-resource-create').click()
    await expect(page.getByTestId('web-agent-resource-creator')).toHaveCount(0)

    let agent: CollaborationAgent | undefined
    await expect
      .poll(async () => {
        const response = await apiRequest<CollaborationAgent[]>(
          request,
          `/api/v1/cloud-projects/${projectId}/chat-agents`
        )
        agent = response.find(item => item.name === displayName)
        return agent?.id ?? ''
      })
      .not.toBe('')
    const team = await apiRequest<{
      bots: Array<{ bot: { id: number } }>
    }>(request, `/api/teams/${agent!.wegentTeamId}`)
    const bot = await apiRequest<{
      capability_mode: 'follow_device' | 'manual'
      mcp_servers: Record<string, unknown>
      plugins: Array<{ id: string }>
      skills: string[]
    }>(request, `/api/bots/${team.bots[0].bot.id}`)
    expect(bot.capability_mode).toBe('manual')
    expect(bot.skills).toContain(SKILL_NAME)
    expect(bot.plugins).toEqual([expect.objectContaining({ id: plugin.id })])
    expect(bot.mcp_servers).toHaveProperty(MCP_SERVER_NAME)
    await expect(page.getByTestId(`project-agent-row-${agent!.id}`)).toContainText(displayName)
    await capture(page, test.info(), 'wegent-01-agent-created')
    return agent!
  }

  async function createIssue(
    request: APIRequestContext,
    projectId: string,
    agentCase: AgentCase
  ): Promise<CollaborationIssue> {
    return apiRequest(request, `/api/v1/cloud-projects/${projectId}/loop-items`, {
      method: 'POST',
      data: {
        title: 'Wegent agent capability execution',
        description: [
          agentCase.prompt,
          `Call get_document_info with nodeId ${agentCase.nodeId}.`,
          `Use the preloaded ${SKILL_NAME} Skill and finish with ${agentCase.answerMarker}.`,
        ].join('\n'),
        status: 'pending',
        priority: 'high',
        tags: ['collaboration-e2e', 'wegent-agent'],
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
