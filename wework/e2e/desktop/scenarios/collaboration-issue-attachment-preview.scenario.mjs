import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT_NAME = `Issue 附件图片预览-${process.pid}`
const ISSUE_TITLE = `中文截图直接预览-${process.pid}`
const ATTACHMENT_NAME = '截屏 2026-10-19 17.53.45.png'
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAYSURBVBhXY/jPwABC/xkYGhj+///P8B8ARFEIec4LfZYAAAAASUVORK5CYII=',
  'base64'
)
const EXPECTED_DISPOSITION = `inline; filename*=UTF-8''${encodeURIComponent(ATTACHMENT_NAME)}`

/**
 * A Chinese screenshot filename must survive upload, content negotiation, the
 * rail thumbnail, and the direct lightbox request. The test asserts the real
 * bytes and decoded image dimensions so a visible fallback cannot pass.
 */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  let backendUrl = ''
  let authToken = ''
  let workspace = null
  let project = null
  let issue = null
  let attachment = null

  async function requestJson(pathname, options = {}) {
    const response = await fetch(`${backendUrl}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })
    const text = await response.text()
    assert.equal(
      response.ok,
      true,
      `${options.method ?? 'GET'} ${pathname} failed with HTTP ${response.status}: ${text}`
    )
    return text ? JSON.parse(text) : null
  }

  async function assertImageDecoded(control, selector) {
    const expression = `(() => {
      const image = document.querySelector(${JSON.stringify(selector)})
      return Boolean(
        image &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.naturalHeight > 0
      )
    })()`
    await control.command('waitFor', selector, {
      expression,
      timeoutMs: uiTimeoutMs,
    })
    assert.match(await control.command('getAttribute', selector, { value: 'src' }), /^blob:/)
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(cloud) {
      backendUrl = cloud.backendUrl
      authToken = cloud.authToken
      workspace = await requestJson('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          name: PROJECT_NAME,
          description: 'Desktop E2E fixture for Issue attachment previews',
        }),
      })
      project = await requestJson(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: JSON.stringify({
          projectKey: 'ATTACH',
          name: PROJECT_NAME,
          description: 'Issue attachment preview regression',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        }),
      })
      issue = await requestJson(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: JSON.stringify({ title: ISSUE_TITLE }),
      })

      const form = new FormData()
      form.set('file', new Blob([PNG_BYTES], { type: 'image/png' }), ATTACHMENT_NAME)
      const upload = await fetch(`${backendUrl}/api/v1/loop-items/${issue.id}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
        body: form,
      })
      const uploadText = await upload.text()
      assert.equal(
        upload.ok,
        true,
        `Uploading the Chinese image attachment failed with HTTP ${upload.status}: ${uploadText}`
      )
      attachment = JSON.parse(uploadText)
      assert.equal(attachment.display_name, ATTACHMENT_NAME)

      const content = await fetch(
        `${backendUrl}/api/v1/loop-item-attachments/${attachment.id}/content`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      )
      assert.equal(
        content.status,
        200,
        `Reading the Chinese image attachment failed with HTTP ${content.status}`
      )
      assert.equal(content.headers.get('content-type'), 'image/png')
      assert.equal(content.headers.get('content-disposition'), EXPECTED_DISPOSITION)
      assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG_BYTES)
    },

    async verify(control) {
      assert.ok(project?.id, 'The attachment preview project fixture is missing')
      assert.ok(issue?.id, 'The attachment preview Issue fixture is missing')
      assert.ok(attachment?.id, 'The attachment preview fixture is missing')

      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', `${CONTENT} [data-testid="collaboration-platform-root"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })

      const issueTitle = `${CONTENT} [data-testid="cloud-todo-detail-title"]`
      await control.command('waitFor', issueTitle, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(await control.command('getValue', issueTitle), ISSUE_TITLE)

      const openAttachment = `${CONTENT} [data-testid="cloud-todo-attachment-open-${attachment.id}"]`
      const thumbnail = `${CONTENT} [data-testid="issue-detail-attachment-thumbnail-${attachment.id}"]`
      await control.command('waitFor', openAttachment, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('scrollIntoView', openAttachment)
      await control.command('waitFor', thumbnail, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await assertImageDecoded(control, thumbnail)
      await captureScreenshot(
        control,
        'collaboration-issue-attachment-preview-01-thumbnail.png',
        CONTENT
      )

      await control.command('click', openAttachment, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const dialog = '[data-testid="cloud-file-preview-dialog"]'
      await control.command('waitFor', dialog, {
        text: ATTACHMENT_NAME,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const previewImage = `${dialog} [data-testid="cloud-file-preview-image"]`
      await control.command('waitFor', previewImage, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await assertImageDecoded(control, previewImage)
      await captureScreenshot(
        control,
        'collaboration-issue-attachment-preview-02-lightbox.png',
        dialog
      )

      await control.command('click', `${dialog} [data-testid="cloud-file-preview-close"]`)
      await control.command('waitFor', dialog, {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
    },

    diagnostics() {
      return {
        workspaceId: workspace?.id ?? null,
        projectId: project?.id ?? null,
        issueId: issue?.id ?? null,
        attachmentId: attachment?.id ?? null,
      }
    },
  }
}
