// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, request as playwrightRequest, type Page } from '@playwright/test'

import { checked, test, type HistoryTask } from '../../fixtures/recent-team-history'

interface PreviewAccess {
  documentCookie: string | null
  localStorageToken: string | null
}

const DANGEROUS_PREVIEW = 'data:text/html,<script>parent.alert(1)</script>'
const FORBIDDEN_PREVIEW = 'javascript:parent.alert(1)'

function previewDocument(): string {
  return `<!doctype html><script>
    function readParent(action) {
      try {
        return action()
      } catch (error) {
        return null
      }
    }
    parent.postMessage({
      type: 'app-preview-access',
      documentCookie: readParent(() => parent.document.cookie),
      localStorageToken: readParent(() => parent.localStorage.getItem('auth_token')),
    }, '*')
  </script>`
}

async function updatePreview(task: HistoryTask, previewUrl: string) {
  const token = process.env.E2E_INTERNAL_SERVICE_TOKEN || process.env.INTERNAL_SERVICE_TOKEN
  expect(token, 'The E2E Backend internal service token must be configured').toBeTruthy()
  const context = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL || 'http://localhost:8000',
  })
  try {
    const response = await context.post('/api/internal/services/update', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        task_id: task.id,
        name: 'Generated app',
        address: '127.0.0.1:3000',
        previewUrl,
      },
    })
    expect(response.status(), await response.text()).toBe(200)
  } finally {
    await context.dispose()
  }
}

async function openTask(page: Page, task: HistoryTask): Promise<void> {
  await page.goto(`/chat?taskId=${task.id}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('message-input')).toBeVisible()
  await expect(page.getByTestId('app-preview-frame')).toBeVisible()
}

async function frameAccess(page: Page): Promise<PreviewAccess> {
  return await page.evaluate(
    () =>
      new Promise<PreviewAccess>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('The real preview did not report its access result')),
          10_000
        )
        window.addEventListener(
          'message',
          event => {
            if ((event.data as { type?: string })?.type === 'app-preview-access') {
              clearTimeout(timeout)
              resolve(event.data as PreviewAccess)
            }
          },
          { once: true }
        )
      })
  )
}

async function expectNoPreviewRequest(page: Page, url: string): Promise<void> {
  const request = page.waitForRequest(current => current.url() === url, { timeout: 1_000 })
  await expect
    .poll(async () => page.getByTestId('app-preview-frame').count(), { timeout: 10_000 })
    .toBe(0)
  expect(await request.catch(() => null)).toBeNull()
}

test('a real app preview cannot read the application DOM or authentication storage', async ({
  page,
  history,
}) => {
  const team = await history.team('preview-access')
  const task = await history.seed(team, 'code')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(previewDocument())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo

  try {
    await updatePreview(task, `http://127.0.0.1:${port}/preview`)
    const accessPromise = frameAccess(page)
    await openTask(page, task)

    expect(await accessPromise).toEqual({ documentCookie: null, localStorageToken: null })
    expect(await page.evaluate(() => document.cookie)).toContain('auth_token=')
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeTruthy()
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
})

test('unsafe preview URLs do not load and a live preview is removed when it becomes unsafe', async ({
  page,
  history,
}) => {
  const team = await history.team('preview-unsafe')
  const task = await history.seed(team, 'code')
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Safe preview</title>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  const safeUrl = `http://127.0.0.1:${port}/safe`

  try {
    await updatePreview(task, FORBIDDEN_PREVIEW)
    await page.goto(`/chat?taskId=${task.id}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-preview-unavailable')).toBeVisible()
    await expect(page.getByTestId('app-preview-frame')).toHaveCount(0)

    // Reload proves the persisted safe URL renders; the later update uses the
    // live task-room WebSocket to remove it without a navigation.
    await updatePreview(task, safeUrl)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('app-preview-frame')).toBeVisible()
    expect(checked(await history.api.get(`/api/tasks/${task.id}`))).toMatchObject({
      app: { previewUrl: safeUrl },
    })

    await updatePreview(task, DANGEROUS_PREVIEW)
    await expectNoPreviewRequest(page, DANGEROUS_PREVIEW)
    await expect(page.getByTestId('app-preview-unavailable')).toBeVisible()
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
})
