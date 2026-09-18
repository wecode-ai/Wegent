import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { inCollaborationSidebar } from '../modules/workspace-flows.mjs'

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
  can_edit: true,
  can_view_detail: true,
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
  completed_at: null,
}
const WEBSITE_TODO_SECOND = {
  ...WEBSITE_TODO,
  id: 'GW-2',
  sequence_number: 2,
  title: '连续拖拽后保持任务状态',
  sort_order: 1,
}
const WEBSITE_TASK_BINDINGS = [WEBSITE_TODO, WEBSITE_TODO_SECOND].map((todo, index) => ({
  id: `binding-${index + 1}`,
  cloud_project_id: WEBSITE_PROJECT.id,
  loop_item_id: todo.id,
  task_user_id: 9001,
  device_id: 'e2e-device',
  task_id: `runtime-${index + 1}`,
  task_title: todo.title,
  backend_task_id: null,
  modelSelection: null,
  workflow_node_id: null,
  binding_type: 'user',
  linked_at: '2026-07-25T00:00:00',
}))
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

function scoped(selector) {
  return `${ACTIVE_WORKBENCH_SELECTOR} ${selector}`
}

async function waitForSignal(signal, timeoutMs, message) {
  let timeout
  try {
    await Promise.race([
      signal,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  const projects = [WEBSITE_PROJECT, MOBILE_PROJECT]
  const todos = [structuredClone(WEBSITE_TODO), structuredClone(WEBSITE_TODO_SECOND)]
  let createdProjectPayload = null
  let reorderRequestCount = 0
  let resolveFirstReorderRequest
  const firstReorderRequest = new Promise(resolve => {
    resolveFirstReorderRequest = resolve
  })
  let releaseFirstReorderResponse
  const firstReorderResponseRelease = new Promise(resolve => {
    releaseFirstReorderResponse = resolve
  })
  let resolveSecondReorderResponse
  const secondReorderResponse = new Promise(resolve => {
    resolveSecondReorderResponse = resolve
  })

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
          items: todos,
          task_bindings: WEBSITE_TASK_BINDINGS,
          members: [],
          agents: [PROJECT_AI],
        })
        return true
      }
      const loopItemsMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/loop-items$/)
      if (request.method === 'GET' && loopItemsMatch) {
        json(response, 200, {
          items: loopItemsMatch[1] === WEBSITE_PROJECT.id ? todos : [],
        })
        return true
      }
      const updateLoopItemMatch = url.pathname.match(/^\/api\/v1\/loop-items\/([^/]+)$/)
      if (request.method === 'PATCH' && updateLoopItemMatch) {
        const todo = todos.find(item => item.id === updateLoopItemMatch[1])
        assert.ok(todo, `Unknown cloud Issue update: ${updateLoopItemMatch[1]}`)
        const update = await readJson(request)
        assert.equal(update.version, todo.version, `Stale cloud Issue update for ${todo.id}`)
        Object.assign(todo, update, {
          version: todo.version + 1,
          updated_at: '2026-07-25T00:00:01',
        })
        json(response, 200, todo)
        return true
      }
      if (
        request.method === 'POST' &&
        url.pathname === `/api/v1/cloud-projects/${WEBSITE_PROJECT.id}/loop-items/reorder`
      ) {
        const input = await readJson(request)
        reorderRequestCount += 1
        const lane = input.item_ids
          .map(id => todos.find(item => item.id === id))
          .filter(Boolean)
          .map((item, sortOrder) => ({ ...item, sort_order: sortOrder }))
        if (reorderRequestCount === 1) {
          resolveFirstReorderRequest()
          await firstReorderResponseRelease
          json(response, 200, { items: lane })
          return true
        }
        for (const item of lane) {
          const todo = todos.find(candidate => candidate.id === item.id)
          Object.assign(todo, item)
        }
        json(response, 200, { items: lane })
        resolveSecondReorderResponse()
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
        json(
          response,
          200,
          todos.find(todo => todo.id === WEBSITE_TODO.id)
        )
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
        inCollaborationSidebar(`[data-testid="collaboration-workspace-${CLOUD_WORKSPACE.id}"]`),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        inCollaborationSidebar(`[data-testid="collaboration-workspace-${CLOUD_WORKSPACE.id}"]`)
      )
      await control.command(
        'waitFor',
        inCollaborationSidebar(
          `[data-testid="collaboration-workspace-project-${WEBSITE_PROJECT.id}"]`
        ),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        inCollaborationSidebar(
          `[data-testid="collaboration-workspace-project-${WEBSITE_PROJECT.id}"]`
        )
      )
      await control.command('waitFor', scoped('[data-testid="collaboration-root"]'), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        scoped(`[data-testid="cloud-todo-card-${WEBSITE_TODO.id}"]`),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'waitFor',
        scoped(`[data-testid="cloud-todo-card-${WEBSITE_TODO_SECOND.id}"]`),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
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
      const reviewColumn = scoped('[data-testid="cloud-todo-column-in_review"]')
      const runningColumn = scoped('[data-testid="cloud-todo-column-in_progress"]')
      const runningDropzone = scoped('[data-testid="cloud-todo-column-dropzone-in_progress"]')
      const firstCard = scoped(`[data-testid="cloud-todo-card-${WEBSITE_TODO.id}"]`)
      const secondCard = scoped(`[data-testid="cloud-todo-card-${WEBSITE_TODO_SECOND.id}"]`)
      await capture(control, 'cloud-space-mention-01-review-cards-ready.png')

      await control.command('dragStart', firstCard, { target: runningDropzone })
      await control.command('dragEnd', firstCard, { target: runningDropzone })
      await waitForSignal(
        firstReorderRequest,
        uiTimeoutMs,
        'The first review-card reorder request did not start'
      )
      await control.command('waitFor', runningColumn, {
        text: WEBSITE_TODO.title,
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'cloud-space-mention-02-first-card-moved-request-held.png')

      await control.command('dragStart', secondCard, { target: runningDropzone })
      await control.command('dragEnd', secondCard, { target: runningDropzone })
      await waitForSignal(
        secondReorderResponse,
        uiTimeoutMs,
        'The second review-card reorder response did not complete'
      )
      releaseFirstReorderResponse()
      await control.command('waitFor', runningColumn, {
        text: WEBSITE_TODO_SECOND.title,
        stableMs: 750,
        timeoutMs: uiTimeoutMs,
      })
      assert.doesNotMatch(
        await control.command('getText', reviewColumn),
        new RegExp(`${WEBSITE_TODO.title}|${WEBSITE_TODO_SECOND.title}`, 'u'),
        'An older reorder response moved an updated Issue back into review'
      )
      await capture(control, 'cloud-space-mention-03-consecutive-moves-stable.png')

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
      await capture(control, 'cloud-space-mention-04-task-detail-activity.png')
    },

    diagnostics() {
      return { createdProjectPayload, reorderRequestCount }
    },

    cleanup() {
      releaseFirstReorderResponse()
    },
  }
}
