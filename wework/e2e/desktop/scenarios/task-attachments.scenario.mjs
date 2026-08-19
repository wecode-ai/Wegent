import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

const PROJECT = {
  id: '896185331840201807',
  public_id: 'e2e-task-attachments',
  project_key: 'TA',
  name: '任务附件验收',
  description: '远程项目仅在显式交付后共享文件',
  project_store: 'backend',
  created_by_user_id: 9001,
  status: 'active',
  version: 1,
  created_at: '2026-08-17T00:00:00',
  updated_at: '2026-08-17T00:00:00',
}

const TASK = {
  id: 'TA-1',
  cloud_project_id: PROJECT.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 9001,
  assignee_user_id: null,
  assignee_agent_id: null,
  title: '整理附件',
  description: '',
  status: 'inbox',
  priority: 'none',
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-08-17T00:00:00',
  updated_at: '2026-08-17T00:00:00',
  completed_at: null,
}

const AGENT = {
  id: 'agent-task-attachments',
  projectId: PROJECT.id,
  name: '附件整理机器人',
  runtime: 'codex',
  model: null,
  systemPrompt: '',
  status: 'active',
  version: 1,
  createdAt: '2026-08-17T00:00:00',
  updatedAt: '2026-08-17T00:00:00',
}

const DELIVERY_FILE = {
  asset_id: 'delivery-asset-1',
  delivery_id: 'delivery-1',
  loop_item_id: 'TA-1',
  loop_item_title: '整理附件',
  relative_path: 'reports/result.pdf',
  display_name: 'result.pdf',
  content_type: 'application/pdf',
  size_bytes: 256,
  delivered_at: '2026-08-17T10:00:00',
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'GET') return false

      if (url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: [PROJECT] })
        return true
      }

      const loopItemsMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/loop-items$/)
      if (loopItemsMatch) {
        json(response, 200, {
          items: loopItemsMatch[1] === PROJECT.id ? [TASK] : [],
        })
        return true
      }

      const chatAgentsMatch = url.pathname.match(
        /^\/api\/v1\/cloud-projects\/([^/]+)\/chat-agents$/
      )
      if (chatAgentsMatch) {
        json(response, 200, chatAgentsMatch[1] === PROJECT.id ? [AGENT] : [])
        return true
      }

      const filesMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/files$/)
      if (filesMatch) {
        json(response, 200, { items: [] })
        return true
      }

      const deliveryFilesMatch = url.pathname.match(
        /^\/api\/v1\/cloud-projects\/([^/]+)\/delivery-files$/
      )
      if (deliveryFilesMatch) {
        json(response, 200, {
          items: deliveryFilesMatch[1] === PROJECT.id ? [DELIVERY_FILE] : [],
        })
        return true
      }

      const deliveryFileContentMatch = url.pathname.match(
        /^\/api\/v1\/delivery-assets\/([^/]+)\/content$/
      )
      if (deliveryFileContentMatch) {
        response.writeHead(200, { 'content-type': 'application/pdf' })
        response.end('result')
        return true
      }

      return false
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-board"]')
      await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', `[data-testid="cloud-sidebar-project-${PROJECT.id}"]`)
      await control.command('waitFor', `[data-testid="cloud-todo-card-TA-1"]`, {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="cloud-project-files-view"]')
      await control.command('waitFor', `[data-testid="delivery-file-${DELIVERY_FILE.asset_id}"]`, {
        timeoutMs: uiTimeoutMs,
      })

      const deliveryText = await control.command(
        'getText',
        `[data-testid="delivery-file-${DELIVERY_FILE.asset_id}"]`
      )
      assert.match(deliveryText, /TA-1/)
      assert.match(deliveryText, /整理附件/)
      assert.match(deliveryText, /reports\/result\.pdf/)

      const taskAttachmentCount = Number(
        await control.command('getElementCount', '[data-testid^="task-attachment-"]', {
          visible: true,
        })
      )
      assert.equal(taskAttachmentCount, 0, 'Remote projects must not expose raw task attachments')

      await control.command(
        'click',
        `[data-testid="delivery-file-preview-${DELIVERY_FILE.asset_id}"]`
      )
      await control.command('waitFor', '[data-testid="cloud-file-preview-sidebar"]', {
        timeoutMs: uiTimeoutMs,
      })
      const previewTitle = await control.command(
        'getText',
        '[data-testid="cloud-file-preview-title"]'
      )
      assert.match(previewTitle, /reports\/result\.pdf/)

      await captureScreenshot(
        control,
        'task-attachments-remote-delivery-only.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
    },

    diagnostics() {
      return {}
    },
  }
}
