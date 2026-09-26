// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient } from './api-client'
import {
  authHeaders,
  clearToolScenario,
  configureToolScenario,
  PROVIDER_NATIVE_API_URL,
  PROVIDER_NATIVE_MOCK_URL,
  type ToolScenarioOptions,
  type ToolScenarioStep,
} from './provider-native-test-support'

const ISSUE_DESCRIPTION =
  'Collect reproducible evidence, preserve attachments, and return the result through Delivery.'

export interface IssueDispatchProjectFixture {
  issueId: string
  projectId: string
  projectPath: string
  workspaceId: string
}

export interface IssueDispatchMockModel {
  modelName: string
  token: string
}

interface ProjectAgent {
  id: string
  name: string
}

function encoded(value: string): string {
  return encodeURIComponent(value)
}

async function firstVisibleOption(locator: Locator): Promise<Locator> {
  await expect(locator.first()).toBeVisible({ timeout: 5_000 })
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index)
    if (await candidate.isVisible()) return candidate
  }
  throw new Error('Expected at least one visible option')
}

export async function createIssueDispatchMockModel(
  request: APIRequestContext,
  suffix: string
): Promise<IssueDispatchMockModel> {
  const login = await createApiClient(request).login(ADMIN_USER.username, ADMIN_USER.password)
  const token = login.data?.access_token || ''
  expect(token).toBeTruthy()
  const modelName = `issue-dispatch-${suffix}-model`
  const response = await request.post(
    `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models`,
    {
      headers: authHeaders(token),
      data: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: { name: modelName, namespace: 'default' },
        spec: {
          modelConfig: {
            env: {
              model: 'openai',
              model_id: 'mock-issue-dispatch-model',
              api_key: 'mock-api-key',
              base_url: `${PROVIDER_NATIVE_MOCK_URL}/v1`,
            },
          },
        },
      },
    }
  )
  expect([200, 201], await response.text()).toContain(response.status())
  return { modelName, token }
}

export async function deleteIssueDispatchMockModel(
  request: APIRequestContext,
  model: IssueDispatchMockModel
): Promise<void> {
  const response = await request.delete(
    `${PROVIDER_NATIVE_API_URL}/api/v1/namespaces/default/models/${encodeURIComponent(
      model.modelName
    )}`,
    { headers: authHeaders(model.token) }
  )
  expect([200, 204, 404]).toContain(response.status())
}

export async function configureIssueDispatchModelScenario(
  request: APIRequestContext,
  matchText: string,
  steps: ToolScenarioStep[],
  options: ToolScenarioOptions = {}
): Promise<() => Promise<void>> {
  await configureToolScenario(request, matchText, steps, options)
  return () => clearToolScenario(request, matchText)
}

export async function createProjectFixture(
  page: Page,
  suffix: string,
  issueTitle: string
): Promise<IssueDispatchProjectFixture> {
  await page.goto('/collaboration', { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  await page.getByTestId('collaboration-workspace-create').click()
  await page.getByTestId('collaboration-workspace-name-input').fill(`Dispatch Workspace ${suffix}`)
  await page
    .getByTestId('collaboration-workspace-description-input')
    .fill('Created through the real Wegent collaboration UI.')
  await page.getByTestId('collaboration-workspace-create-confirm').click()
  await expect(page).toHaveURL(/\/collaboration\/workspaces\/[^/?]+$/)

  const workspaceId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
  expect(workspaceId).not.toBe('')
  await page.getByTestId('collaboration-workspace-project-create').click()
  await page.getByTestId('collaboration-workspace-project-create-blank').click()
  await page.getByTestId('collaboration-project-name-input').fill(`Dispatch Project ${suffix}`)
  await expect(page.getByTestId('collaboration-project-storage-local')).toHaveCount(0)
  await expect(page.getByTestId('collaboration-project-storage-cloud')).toHaveCount(0)
  await expect(page.getByText('本地协作', { exact: true })).toHaveCount(0)
  await expect(page.getByText('云端协作', { exact: true })).toHaveCount(0)
  await page.getByTestId('collaboration-project-create-confirm').click()

  await expect(page).toHaveURL(
    new RegExp(`/collaboration/workspaces/${encoded(workspaceId)}/projects/[^/?]+$`)
  )
  const projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
  expect(projectId).not.toBe('')
  const projectPath = `/collaboration/workspaces/${encoded(workspaceId)}/projects/${encoded(
    projectId
  )}`

  await initializeProjectExecutionEnvironment(page)
  await page.getByTestId('collaboration-issue-create').click()
  await page.getByTestId('cloud-todo-title').fill(issueTitle)
  await page.getByTestId('cloud-todo-detail-description').fill(ISSUE_DESCRIPTION)
  await page.getByTestId('cloud-todo-create-confirm').click()
  await expect(page).toHaveURL(new RegExp(`${projectPath}/issues/[^/?]+$`))
  const issueId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
  expect(issueId).not.toBe('')
  await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
  return { issueId, projectId, projectPath, workspaceId }
}

export async function initializeProjectExecutionEnvironment(page: Page): Promise<void> {
  await page.getByTestId('collaboration-tab-manage').click()
  await page.getByTestId('collaboration-project-settings-environments').click()
  const initialize = page.locator(
    '[data-testid^="collaboration-project-execution-environment-initialize-"]'
  )
  await expect(initialize.first()).toBeVisible()
  await initialize.first().click()
  await expect(
    page.getByTestId('collaboration-project-execution-environment-completion-status')
  ).toContainText('环境已初始化')
  await page.getByTestId('collaboration-tab-board').click()
}

export async function addProjectMember(page: Page, userName: string): Promise<string> {
  await page.getByTestId('cloud-todo-detail-close').click()
  await expect(page.getByTestId('collaboration-issue-detail')).toHaveCount(0)
  await page.getByTestId('collaboration-tab-manage').click()
  await page.getByTestId('collaboration-project-settings-participants').click()
  await page.getByTestId('collaboration-participants-tab-members').click()
  await page.getByTestId('cloud-project-members-toggle').click()
  await page.getByTestId('cloud-member-search').fill(userName)
  await page.getByTestId('cloud-member-role').selectOption('Developer')
  const result = await firstVisibleOption(page.locator('[data-testid^="cloud-member-result-"]'))
  const resultTestId = await result.getAttribute('data-testid')
  const userId = resultTestId?.replace('cloud-member-result-', '')
  if (!userId) throw new Error(`Member search result for ${userName} did not expose a user ID`)
  await result.click()
  await expect(
    page.locator('[data-testid^="cloud-project-member-"]').filter({ hasText: userName })
  ).toBeVisible()
  return userId
}

export async function createProjectAgent(
  page: Page,
  name: string,
  modelName: string
): Promise<ProjectAgent> {
  const issueDetail = page.getByTestId('collaboration-issue-detail')
  if ((await issueDetail.count()) > 0) {
    const closeButton = page.getByTestId('cloud-todo-detail-close')
    await expect(closeButton).toBeVisible()
    await closeButton.click()
    await expect(page).not.toHaveURL(/\/issues\//)
    await expect(issueDetail).toHaveCount(0)
  }
  await page.getByTestId('collaboration-tab-manage').click()
  await page.getByTestId('collaboration-project-settings-participants').click()
  await page.getByTestId('collaboration-participants-tab-agents').click()
  await page.getByTestId('project-agent-add').click()
  await page.getByTestId('project-agent-mode-create').click()
  await expect(page.getByTestId('web-agent-resource-creator')).toBeVisible()
  await page.getByTestId('web-agent-display-name').fill(name)
  await page.getByTestId('web-agent-model').selectOption({ label: modelName })
  await page
    .getByTestId('web-agent-system-prompt')
    .fill('Execute only the assigned dispatch task and submit evidence through Delivery.')
  await page.getByTestId('web-agent-resource-create').click()
  await expect(page.getByTestId('web-agent-resource-creator')).toHaveCount(0)
  await expect(
    page.locator('[data-testid^="project-agent-row-"]').filter({ hasText: name })
  ).toBeVisible()
  const agents = await page.evaluate(async () => {
    const projectId = new URL(window.location.href).pathname.split('/projects/')[1]?.split('/')[0]
    const response = await fetch(
      `/api/v1/cloud-projects/${encodeURIComponent(projectId || '')}/chat-agents`,
      { cache: 'no-store' }
    )
    if (!response.ok) throw new Error(`Unable to read created project agent: ${response.status}`)
    return (await response.json()) as ProjectAgent[]
  })
  const agent = agents.find(candidate => candidate.name === name)
  if (!agent) throw new Error(`Created project agent ${name} was not returned by the project API`)
  return agent
}

export async function createCollaborationGroup(
  page: Page,
  name: string,
  members: {
    agentIds: string[]
    humanId: string
    leader: { id: string; type: 'agent' | 'human' }
  }
): Promise<string> {
  await page.getByTestId('collaboration-participants-tab-groups').click()
  await page.getByTestId('collaboration-group-open-create').click()
  await page.getByTestId('collaboration-group-name').fill(name)
  await page.getByTestId('collaboration-group-create-add-members').click()
  for (const agentId of members.agentIds) {
    await page.getByTestId(`collaboration-group-create-member-agent-${agentId}`).click()
  }
  if (members.humanId) {
    await page.getByTestId(`collaboration-group-create-member-human-${members.humanId}`).click()
  }
  await page.getByTestId('collaboration-group-create-add-members').click()
  await page.getByTestId('collaboration-group-leader').click()
  await page
    .getByTestId(`collaboration-group-leader-${members.leader.type}-${members.leader.id}`)
    .click()
  await page.getByTestId('collaboration-group-create').click()
  const detail = page.locator('div[data-testid^="collaboration-group-detail-"]').filter({
    hasText: name,
  })
  await expect(detail).toBeVisible()
  const testId = await detail.getAttribute('data-testid')
  const groupId = testId?.replace('collaboration-group-detail-', '')
  if (!groupId) throw new Error(`Created collaboration group ${name} did not expose its ID`)
  return groupId
}
