import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'

const PROJECT = {
  id: '896185331840201807',
  public_id: 'e2e-task-attachments',
  project_key: 'TA',
  name: '任务附件验收',
  description: '任务对话附件统一展示验收',
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
  assignee_agent_id: 'agent-task-attachments',
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

const TASK_ATTACHMENT = {
  id: 'task-attachment-1',
  loop_item_id: TASK.id,
  loop_item_title: TASK.title,
  display_name: 'conversation-image.png',
  content_type: 'image/png',
  size_bytes: 256,
  sha256: 'e2e-task-attachment-sha',
  created_by_user_id: 9001,
  created_at: '2026-08-17T10:00:00',
  markdown_url: 'wegent://attachments/task-attachment-1',
  markdown: '[conversation-image.png](wegent://attachments/task-attachment-1)',
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let taskAttachmentListRequests = 0

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
        json(response, 200, { items: [] })
        return true
      }

      const taskAttachmentsMatch = url.pathname.match(
        /^\/api\/v1\/cloud-projects\/([^/]+)\/task-attachments$/
      )
      if (taskAttachmentsMatch) {
        taskAttachmentListRequests += 1
        json(response, 200, {
          items: taskAttachmentsMatch[1] === PROJECT.id ? [TASK_ATTACHMENT] : [],
        })
        return true
      }

      return false
    },

    async verify(control) {
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
      await control.command('waitFor', `[data-testid="cloud-todo-card-${TASK.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="cloud-project-files-view"]')
      await control.command('waitFor', `[data-testid="task-attachment-${TASK_ATTACHMENT.id}"]`, {
        timeoutMs: uiTimeoutMs,
      })

      const attachmentText = await control.command(
        'getText',
        `[data-testid="task-attachment-${TASK_ATTACHMENT.id}"]`
      )
      assert.match(attachmentText, /TA-1/)
      assert.match(attachmentText, /整理附件/)
      assert.match(attachmentText, /conversation-image\.png/)
      assert.equal(taskAttachmentListRequests, 1, 'Task attachments should be loaded once')

      await captureScreenshot(
        control,
        'task-attachments-01-files-view.png',
        ACTIVE_WORKBENCH_SELECTOR
      )
    },

    diagnostics() {
      return { taskAttachmentListRequests }
    },
  }
}
