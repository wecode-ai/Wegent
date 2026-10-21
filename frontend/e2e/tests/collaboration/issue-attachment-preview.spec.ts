// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Locator } from '@playwright/test'
import { webApi } from '../../utils/collaboration-test-support'

interface Resource {
  id: string
  version: number
}

const filename = '截屏 2026-10-19 17.53.45.png'
const imageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAYSURBVBhXY/jPwABC/xkYGhj+///P8B8ARFEIec4LfZYAAAAASUVORK5CYII=',
  'base64'
)

async function expectDecodedImage(image: Locator): Promise<void> {
  await expect(image).toBeVisible()
  await image.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => ({
        complete: element.complete,
        width: element.naturalWidth,
        height: element.naturalHeight,
      }))
    )
    .toEqual({ complete: true, width: 2, height: 2 })
}

test('uploads, reopens and removes a Chinese-named Issue image with decoded previews', async ({
  page,
}) => {
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
  const suffix = crypto.randomUUID()
  const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
    method: 'POST',
    body: { name: `Attachment preview ${suffix}` },
  })
  let project: Resource | undefined
  try {
    project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
      method: 'POST',
      body: {
        workspace_id: workspace.id,
        name: `Chinese image ${suffix}`,
        task_provider: 'local',
        visibility: 'private',
      },
    })
    const issue = await webApi<Resource>(page, `/api/v1/cloud-projects/${project.id}/loop-items`, {
      method: 'POST',
      body: { title: `Image preview ${suffix}` },
    })
    await page.goto(
      `/collaboration/workspaces/${workspace.id}/projects/${project.id}/issues/${issue.id}`
    )
    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    await page.getByTestId('cloud-todo-detail-title').click()
    await expect(page.getByTestId('cloud-todo-detail-title')).toBeEditable()

    // Observe the real thumbnail request, rather than accepting an upload badge.
    const contentResponse = page.waitForResponse(response =>
      /\/loop-item-attachments\/[^/]+\/content$/.test(new URL(response.url()).pathname)
    )
    const uploadResponse = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(`/loop-items/${issue.id}/attachments`)
    )
    await page.getByTestId('cloud-todo-attachment-input').setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: imageBytes,
    })
    const uploaded = await uploadResponse
    expect(uploaded.status()).toBe(201)
    const attachment = (await uploaded.json()) as { id: string; display_name: string }
    expect(attachment.display_name).toBe(filename)
    const content = await contentResponse
    expect(content.status()).toBe(200)
    expect(content.headers()['content-type']).toBe('image/png')
    expect(content.headers()['content-disposition']).toBe(
      `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
    )
    expect(await content.body()).toEqual(imageBytes)

    const thumbnail = page.getByTestId(`issue-detail-attachment-thumbnail-${attachment.id}`)
    await expectDecodedImage(thumbnail)
    await expect(thumbnail).toHaveAttribute('src', /^blob:/)
    await page.reload()
    await expectDecodedImage(thumbnail)

    const previewResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith(`/loop-item-attachments/${attachment.id}/content`)
    )
    await page.getByTestId(`cloud-todo-attachment-open-${attachment.id}`).click()
    const previewContent = await previewResponse
    expect(previewContent.status()).toBe(200)
    expect(await previewContent.body()).toEqual(imageBytes)
    await expect(page.getByTestId('browser-attachment-preview-dialog')).toBeVisible()
    await expectDecodedImage(page.getByTestId('browser-attachment-preview-image'))
    await page.getByTestId('browser-attachment-preview-close').click()
    await expect(page.getByTestId('browser-attachment-preview-dialog')).toHaveCount(0)

    await page.getByTestId('cloud-todo-detail-title').click()
    await expect(page.getByTestId('cloud-todo-detail-title')).toBeEditable()
    await page.getByTestId(`cloud-todo-attachment-delete-${attachment.id}`).click()
    await expect(thumbnail).toHaveCount(0)
    await page.reload()
    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    await expect(page.getByTestId(`cloud-todo-attachment-open-${attachment.id}`)).toHaveCount(0)
    const remaining = await webApi<Array<{ id: string }>>(
      page,
      `/api/v1/loop-items/${issue.id}/attachments`
    )
    expect(remaining).toEqual([])
  } finally {
    if (project) {
      const current = await webApi<Resource>(page, `/api/v1/cloud-projects/${project.id}`)
      await webApi(page, `/api/v1/cloud-projects/${project.id}?version=${current.version}`, {
        method: 'DELETE',
      })
    }
    const current = await webApi<Resource>(page, `/api/v1/workspaces/${workspace.id}`)
    await webApi(page, `/api/v1/workspaces/${workspace.id}?version=${current.version}`, {
      method: 'DELETE',
    })
  }
})
