import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR = '[data-workspace-tab-content][aria-hidden="false"]'

const CLOUD_WORKSPACE = {
  id: '728116431860928513',
  public_id: 'e2e-cloud-workspace',
  name: '官网协作空间',
  description: '官网与移动端项目的云协作空间',
  created_by_user_id: 9001,
  access_role: 'Owner',
  member_count: 1,
  project_count: 2,
  agent_count: 0,
  execution_environment_count: 0,
  is_default: false,
  status: 'active',
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
}
const WEBSITE_PROJECT = {
  id: '896185331840201807',
  public_id: 'e2e-public-website',
  project_key: 'GW',
  name: '官网改版',
  description: '官网改版协作空间',
  workspace_id: CLOUD_WORKSPACE.id,
  project_store: 'backend',
  access_role: 'Owner',
  current_user_id: 9001,
  current_user_name: 'E2E Owner',
  created_by_user_id: 9001,
  status: 'active',
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
}
const MOBILE_PROJECT = {
  ...WEBSITE_PROJECT,
  id: '617164117691150677',
  public_id: 'e2e-public-mobile',
  project_key: 'MB',
  name: '移动端重构',
  description: '',
}
const WEBSITE_TODO = {
  id: 'GW-1',
  cloud_project_id: WEBSITE_PROJECT.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 9001,
  assignee_user_id: null,
  assignee_agent_id: 'agent-codex-helper',
  title: '接入新版登录页',
  description: '',
  status: 'in_review',
  priority: 'high',
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
  completed_at: null,
}
const PROJECT_AI = {
  id: 'agent-codex-helper',
  projectId: WEBSITE_PROJECT.id,
  name: 'Codex Helper',
  runtime: 'codex',
  model: null,
  systemPrompt: '你是官网改版项目空间里的 AI 协作者。',
  status: 'active',
  version: 1,
  createdAt: '2026-07-25T00:00:00',
  updatedAt: '2026-07-25T00:00:00',
}
const WEBSITE_FILE = {
  id: '1906534447060216960',
  cloud_project_id: WEBSITE_PROJECT.id,
  path: '需求文档.md',
  name: '需求文档.md',
  kind: 'file',
  content_type: 'text/markdown',
  size_bytes: 12,
  sha256: null,
  description: '',
  created_by_user_id: 9001,
  updated_by_user_id: 9001,
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  const projects = [WEBSITE_PROJECT, MOBILE_PROJECT]
  let createdProjectPayload = null

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/workspaces') {
        json(response, 200, { items: [CLOUD_WORKSPACE] })
        return true
      }
      if (request.method === 'GET' && url.pathname === `/api/v1/workspaces/${CLOUD_WORKSPACE.id}`) {
        json(response, 200, CLOUD_WORKSPACE)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/workspaces/${CLOUD_WORKSPACE.id}/projects`
      ) {
        json(response, 200, { items: projects })
        return true
      }
      if (
        request.method === 'GET' &&
        [
          `/api/v1/workspaces/${CLOUD_WORKSPACE.id}/members`,
          `/api/v1/workspaces/${CLOUD_WORKSPACE.id}/agents`,
          `/api/v1/workspaces/${CLOUD_WORKSPACE.id}/execution-environments`,
        ].includes(url.pathname)
      ) {
        json(response, 200, { items: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/resources') {
        json(response, 200, { agents: [], execution_environments: [] })
        return true
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: projects })
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/cloud-projects') {
        createdProjectPayload = await readJson(request)
        const created = {
          ...WEBSITE_PROJECT,
          id: '702251189240268801',
          public_id: 'e2e-public-created',
          project_key: createdProjectPayload.project_key ?? 'E2E',
          name: createdProjectPayload.name,
          description: createdProjectPayload.description ?? '',
        }
        projects.unshift(created)
        json(response, 200, created)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${WEBSITE_PROJECT.id}`
      ) {
        json(response, 200, WEBSITE_PROJECT)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${WEBSITE_PROJECT.id}/board-snapshot`
      ) {
        json(response, 200, {
          items: [WEBSITE_TODO],
          task_bindings: [],
          members: [],
          agents: [PROJECT_AI],
        })
        return true
      }
      const loopItemsMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/loop-items$/)
      if (request.method === 'GET' && loopItemsMatch) {
        json(response, 200, {
          items: loopItemsMatch[1] === WEBSITE_PROJECT.id ? [WEBSITE_TODO] : [],
        })
        return true
      }
      const chatAgentsMatch = url.pathname.match(
        /^\/api\/v1\/cloud-projects\/([^/]+)\/chat-agents$/
      )
      if (request.method === 'GET' && chatAgentsMatch) {
        json(response, 200, chatAgentsMatch[1] === WEBSITE_PROJECT.id ? [PROJECT_AI] : [])
        return true
      }
      const filesMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/files$/)
      if (request.method === 'GET' && filesMatch) {
        json(response, 200, {
          items: filesMatch[1] === WEBSITE_PROJECT.id ? [WEBSITE_FILE] : [],
        })
        return true
      }
      if (request.method === 'GET' && url.pathname === `/api/v1/loop-items/${WEBSITE_TODO.id}`) {
        json(response, 200, WEBSITE_TODO)
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/loop-items/${WEBSITE_TODO.id}/attachments`
      ) {
        json(response, 200, [])
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/loop-items/${WEBSITE_TODO.id}/comments`
      ) {
        json(response, 200, [])
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/loop-items/${WEBSITE_TODO.id}/assignments`
      ) {
        json(response, 200, { items: [] })
        return true
      }
      if (
        request.method === 'GET' &&
        url.pathname === `/api/v1/cloud-projects/${WEBSITE_PROJECT.id}/executions`
      ) {
        json(response, 200, { items: [] })
        return true
      }
      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', '[data-testid="wework-collaboration-platform"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `[data-testid="collaboration-workspace-${CLOUD_WORKSPACE.id}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="collaboration-workspace-${CLOUD_WORKSPACE.id}"]`
      )
      await control.command(
        'waitFor',
        `[data-testid="collaboration-workspace-project-${WEBSITE_PROJECT.id}"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        `[data-testid="collaboration-workspace-project-${WEBSITE_PROJECT.id}"]`
      )
      await control.command('waitFor', '[data-testid="collaboration-root"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `[data-testid="cloud-todo-card-${WEBSITE_TODO.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      const projectSnapshot = await snapshot(control)
      assert.equal(
        projectSnapshot.testIds.includes('cloud-todo-workspace'),
        false,
        'The native Collaboration tab still rendered the retired cloud workspace shell'
      )
      assert.equal(
        projectSnapshot.testIds.includes('cloud-project-chat-view'),
        false,
        'The retired project group-chat tab is still rendered'
      )
      assert.equal(
        projectSnapshot.text.includes('群聊'),
        false,
        'The project header still exposes group chat copy'
      )
      await control.command('click', `[data-testid="cloud-todo-card-${WEBSITE_TODO.id}"]`)
      await control.command('waitFor', '[data-testid="collaboration-issue-detail"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-task-activity-list"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-task-activity-composer"]', {
        timeoutMs: uiTimeoutMs,
      })
      const detailSnapshot = await snapshot(control)
      assert.ok(
        detailSnapshot.text.includes(WEBSITE_TODO.title),
        'The shared Issue detail lost the selected cloud Issue context'
      )
      assert.ok(
        detailSnapshot.text.includes(PROJECT_AI.name),
        'The shared activity mention target did not include the cloud project agent context'
      )
      assert.equal(
        detailSnapshot.testIds.includes(`task-discussion-${WEBSITE_TODO.id}`),
        false,
        'Task activity opened the old discussion side drawer'
      )
      await capture(control, 'cloud-space-mention-06-task-detail-activity.png')
    },

    diagnostics() {
      return { createdProjectPayload }
    },
  }
}
