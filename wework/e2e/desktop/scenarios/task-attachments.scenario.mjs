import { requestJson } from '../modules/harness-app-fixture.mjs'
import assert from 'node:assert/strict'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { inCollaborationSidebar, selectCollaborationDomain } from '../modules/workspace-flows.mjs'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'

const WORKSPACE = { name: '附件验收空间' }
const PROJECT = { name: '任务附件验收' }
const TASK = { title: '整理附件' }
const DELIVERY_FILE = {}

function blankPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ]
  let content = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = content.length
    content += index + 1 + ' 0 obj\n' + body + '\nendobj\n'
    return String(offset).padStart(10, '0') + ' 00000 n \n'
  })
  const xref = content.length
  content += 'xref\n0 5\n0000000000 65535 f \n' + offsets.join('')
  content += 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return content
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  return {
    async prepareCloud({ backendUrl, authToken }) {
      const request = (path, options) => requestJson(backendUrl, authToken, path, options)
      Object.assign(
        WORKSPACE,
        await request('/api/v1/workspaces', {
          method: 'POST',
          body: JSON.stringify({ name: WORKSPACE.name }),
        })
      )
      Object.assign(
        PROJECT,
        await request('/api/v1/workspaces/' + WORKSPACE.id + '/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: PROJECT.name,
            projectKey: 'TA',
            taskProvider: 'local',
            visibility: 'private',
          }),
        })
      )
      Object.assign(
        TASK,
        await request('/api/v1/cloud-projects/' + PROJECT.id + '/loop-items', {
          method: 'POST',
          body: JSON.stringify({ title: TASK.title }),
        })
      )
      const delivery = await request('/api/v1/loop-items/' + TASK.id + '/deliveries', {
        method: 'POST',
        body: JSON.stringify({ title: '附件整理结果', markdown: '' }),
      })
      const form = new FormData()
      form.set('relative_path', 'reports/result.pdf')
      form.set('file', new Blob([blankPdf()], { type: 'application/pdf' }), 'result.pdf')
      const asset = await request('/api/v1/deliveries/' + delivery.id + '/assets', {
        method: 'POST',
        body: form,
      })
      DELIVERY_FILE.asset_id = asset.id
      await request('/api/v1/deliveries/' + delivery.id + '/finalize', {
        method: 'POST',
        body: JSON.stringify({ fulfillments: [] }),
      })
    },

    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const activeBoard = '[data-workspace-tab-content][aria-hidden="false"]'
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="wework-collaboration-platform"]`,
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await selectCollaborationDomain(control, activeBoard, 'cloud')
      const workspaceSelector = inCollaborationSidebar(
        `[data-testid="collaboration-workspace-${WORKSPACE.id}"]`
      )
      await control.command('waitFor', workspaceSelector, {
        text: WORKSPACE.name,
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', workspaceSelector)
      await control.command(
        'waitFor',
        inCollaborationSidebar(`[data-testid="collaboration-workspace-project-${PROJECT.id}"]`),
        {
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        inCollaborationSidebar(`[data-testid="collaboration-workspace-project-${PROJECT.id}"]`)
      )
      await control.command('waitFor', `${activeBoard} [data-testid="collaboration-board"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        `${activeBoard} [data-testid="collaboration-issue-${TASK.id}"]`,
        {
          text: TASK.title,
          timeoutMs: uiTimeoutMs,
        }
      )

      await selectCollaborationProjectView(control, activeBoard, 'files')
      await control.command('waitFor', `${activeBoard} [data-testid="cloud-files-view"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'task-attachments-after-files-click.png')
      const filesView = `${activeBoard} [data-testid="cloud-files-view"]`
      await control.command('waitFor', filesView, {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'task-attachments-files-view.png')
      for (const entryTestId of [
        'cloud-file-browser-entry-root:issues',
        `cloud-file-browser-entry-delivery-item:${TASK.id}`,
        `cloud-file-browser-entry-delivery-path:${TASK.id}:reports`,
      ]) {
        const entrySelector = `${filesView} [data-testid="${entryTestId}"]`
        await control.command('waitFor', entrySelector, { timeoutMs: uiTimeoutMs })
        await control.command('click', `${entrySelector} button`)
      }
      const deliveryFileSelector = `${filesView} [data-testid="delivery-file-${DELIVERY_FILE.asset_id}"]`
      await control.command('waitFor', deliveryFileSelector, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'task-attachments-delivery-file.png')

      const deliveryText = await control.command('getText', deliveryFileSelector)
      assert.match(deliveryText, /result\.pdf/)
      const breadcrumbText = await control.command(
        'getText',
        `${filesView} [data-testid="cloud-file-breadcrumbs"]`
      )
      assert.match(breadcrumbText, /Issues/)
      assert.match(breadcrumbText, /整理附件/)
      assert.match(breadcrumbText, /reports/)

      const taskAttachmentCount = Number(
        await control.command('getElementCount', '[data-testid^="task-attachment-"]', {
          visible: true,
        })
      )
      assert.equal(taskAttachmentCount, 0, 'Remote projects must not expose raw task attachments')

      await control.command(
        'click',
        `${filesView} [data-testid="delivery-file-preview-${DELIVERY_FILE.asset_id}"]`
      )
      await control.command('waitFor', '[data-testid="cloud-file-preview-sidebar"]', {
        timeoutMs: uiTimeoutMs,
      })
      const previewTitle = await control.command(
        'getText',
        '[data-testid="cloud-file-preview-title"]'
      )
      assert.match(previewTitle, /reports\/result\.pdf/)

      await captureScreenshot(control, 'task-attachments-remote-delivery-only.png', activeBoard)
    },

    diagnostics() {
      return {}
    },
  }
}
