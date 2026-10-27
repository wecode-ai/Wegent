import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

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
  let cloudFile = null

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

  async function uploadImage(pathname, values = {}) {
    const form = new FormData()
    form.set('file', new Blob([PNG_BYTES], { type: 'image/png' }), ATTACHMENT_NAME)
    for (const [key, value] of Object.entries(values)) form.set(key, value)
    const response = await fetch(`${backendUrl}${pathname}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    })
    const text = await response.text()
    assert.equal(
      response.status,
      201,
      `Uploading ${pathname} failed with HTTP ${response.status}: ${text}`
    )
    return JSON.parse(text)
  }

  async function assertImageContent(pathname) {
    const content = await fetch(`${backendUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
    assert.equal(content.status, 200, `Reading ${pathname} failed with HTTP ${content.status}`)
    assert.equal(content.headers.get('content-type'), 'image/png')
    assert.equal(content.headers.get('content-disposition'), EXPECTED_DISPOSITION)
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG_BYTES)
  }

  async function assertImageDecoded(control, selector) {
    await control.command('waitFor', selector, { visible: true, timeoutMs: uiTimeoutMs })
    const image = JSON.parse(await control.command('decodeImage', selector))
    assert.equal(image.complete, true)
    assert.equal(image.naturalWidth, 2)
    assert.equal(image.naturalHeight, 2)
    assert.match(image.src, /^blob:/)
  }

  async function openIssue(control) {
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
    const title = `${CONTENT} [data-testid="cloud-todo-detail-title"]`
    await control.command('waitFor', title, { visible: true, timeoutMs: uiTimeoutMs })
    assert.equal(await control.command('getValue', title), ISSUE_TITLE)
  }

  async function assertThumbnailDecoded(control) {
    const open = `${CONTENT} [data-testid="cloud-todo-attachment-open-${attachment.id}"]`
    await control.command('waitFor', open, { visible: true, timeoutMs: uiTimeoutMs })
    await control.command('scrollIntoView', open)
    await assertImageDecoded(
      control,
      `${CONTENT} [data-testid="issue-detail-attachment-thumbnail-${attachment.id}"]`
    )
    return open
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

      attachment = await uploadImage(`/api/v1/loop-items/${issue.id}/attachments`)
      assert.equal(attachment.display_name, ATTACHMENT_NAME)
      await assertImageContent(`/api/v1/loop-item-attachments/${attachment.id}/content`)
      cloudFile = await uploadImage(`/api/v1/cloud-projects/${project.id}/files`, {
        path: ATTACHMENT_NAME,
      })
      assert.equal(cloudFile.name, ATTACHMENT_NAME)
      await assertImageContent(`/api/v1/cloud-projects/files/${cloudFile.id}/content`)
    },

    async verify(control) {
      assert.ok(project?.id, 'The attachment preview project fixture is missing')
      assert.ok(issue?.id, 'The attachment preview Issue fixture is missing')
      assert.ok(attachment?.id, 'The attachment preview fixture is missing')
      assert.ok(cloudFile?.id, 'The cloud file preview fixture is missing')

      await ensureExperimentalFeaturesEnabled(control)
      await openIssue(control)
      const openAttachment = await assertThumbnailDecoded(control)
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

      await reloadMainWindow(control, 'Attachment previews did not reconnect after reload')
      await openIssue(control)
      await assertThumbnailDecoded(control)

      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}`,
      })
      const filesTab = `${CONTENT} [data-testid="collaboration-tab-files"]`
      await control.command('waitFor', filesTab, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('click', filesTab)
      const filesView = `${CONTENT} [data-testid="cloud-files-view"]`
      const shared = `${filesView} [data-testid="cloud-file-browser-entry-root:shared"] button`
      await control.command('waitFor', shared, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('click', shared)
      const openCloudFile = `${filesView} [data-testid="cloud-file-preview-${cloudFile.id}"]`
      await control.command('waitFor', openCloudFile, { visible: true, timeoutMs: uiTimeoutMs })
      await control.command('click', openCloudFile)
      const sidebar = `${filesView} [data-testid="cloud-file-preview-sidebar"]`
      await control.command('waitFor', `${sidebar} [data-testid="cloud-file-preview-title"]`, {
        text: ATTACHMENT_NAME,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      // The shared Files surface renders binary metadata only after reading
      // content successfully; the Issue lightbox above decodes the same PNG.
      await control.command('waitFor', `${sidebar} p`, {
        text: `${ATTACHMENT_NAME} · ${PNG_BYTES.length} B`,
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(
        control,
        'collaboration-issue-attachment-preview-03-cloud-file.png',
        sidebar
      )
    },

    diagnostics() {
      return {
        workspaceId: workspace?.id ?? null,
        projectId: project?.id ?? null,
        issueId: issue?.id ?? null,
        attachmentId: attachment?.id ?? null,
        cloudFileId: cloudFile?.id ?? null,
      }
    },
  }
}
