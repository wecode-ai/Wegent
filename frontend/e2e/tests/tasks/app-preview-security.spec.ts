// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, request as playwrightRequest, type Page } from '@playwright/test'

import { checked, test, type HistoryTask } from '../../fixtures/recent-team-history'
import { createAppPreviewServer } from '../../utils/app-preview-server'

interface PreviewAccess {
  type: 'app-preview-access'
  origin: string
  parentDom: string
  parentCookie: string
  parentLocalStorage: string
  parentSessionStorage: string
  ownLocalStorage: string
}

type PreviewWindow = typeof window & {
  previewAccess: PreviewAccess[]
  unsafePreviewExecutions: number
}

function previewDocument(): string {
  return `<!doctype html><title>Real preview</title>
    <h1 id="execution-marker">Preview script has not run</h1>
    <script>
      function access(action) {
        try {
          action()
          return 'allowed'
        } catch (error) {
          return error.name
        }
      }
      document.getElementById('execution-marker').textContent = 'Preview script executed'
      parent.postMessage({
        type: 'app-preview-access',
        parentDom: access(() => parent.document.querySelector('body')),
        parentCookie: access(() => parent.document.cookie),
        parentLocalStorage: access(() => parent.localStorage.getItem('auth_token')),
        parentSessionStorage: access(() => parent.sessionStorage.getItem('preview-auth-marker')),
        ownLocalStorage: access(() => localStorage.getItem('auth_token')),
      }, '*')
    </script>`
}

async function observePreview(page: Page, token: string): Promise<void> {
  await page.addInitScript(token => {
    if (window !== window.top) return
    // The real issued token also authenticates the frontend at the proxy origin.
    localStorage.setItem('auth_token', token)
    localStorage.setItem(
      'auth_token_expire',
      String(JSON.parse(atob(token.split('.')[1])).exp * 1000)
    )
    sessionStorage.setItem('preview-auth-marker', 'parent-authentication-state')
    const state = window as PreviewWindow
    state.previewAccess = []
    state.unsafePreviewExecutions = 0
    window.addEventListener('message', event => {
      if (event.data?.type === 'unsafe-preview-executed') {
        state.unsafePreviewExecutions += 1
      }
      const frame = document.querySelector<HTMLIFrameElement>('[data-testid=app-preview-frame]')
      if (event.source === frame?.contentWindow && event.data?.type === 'app-preview-access') {
        state.previewAccess.push({ ...event.data, origin: event.origin })
      }
    })
  }, token)
}

async function updatePreview(task: HistoryTask, previewUrl: string): Promise<void> {
  const token = process.env.E2E_INTERNAL_SERVICE_TOKEN || process.env.INTERNAL_SERVICE_TOKEN
  expect(token, 'The E2E Backend internal service token must be configured').toBeTruthy()
  const context = await playwrightRequest.newContext({
    baseURL: process.env.E2E_API_URL || 'http://localhost:8000',
  })
  try {
    const response = await context.post('/api/internal/services/update', {
      headers: { Authorization: `Bearer ${token}` },
      data: { task_id: task.id, name: 'Generated app', address: 'localhost:3000', previewUrl },
    })
    expect(response.status()).toBe(200)
  } finally {
    await context.dispose()
  }
}

async function openTask(page: Page, origin: string, task: HistoryTask): Promise<void> {
  await page.goto(`${origin}/chat?taskId=${task.id}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: /^(Preview|预览)$/ })).toBeVisible()
}

async function expectExecutedPreview(page: Page, previewUrl: string): Promise<void> {
  await expect(page.getByTestId('app-preview-frame')).toBeVisible()
  await expect(page.getByTestId('app-preview-frame')).toHaveAttribute('src', previewUrl)
  await expect(
    page.frameLocator('[data-testid=app-preview-frame]').getByText('Preview script executed')
  ).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => (window as PreviewWindow).previewAccess.length))
    .toBe(1)
}

// The default Chromium CI project discovers this spec. Only model services are mocked.
test('a same-origin app preview executes but cannot access parent DOM or authentication storage', async ({
  page,
  history,
  baseURL,
}) => {
  const team = await history.team('preview-access')
  const task = await history.seed(team, 'code')
  const server = await createAppPreviewServer(baseURL!, previewDocument())
  const previewUrl = `${server.origin}/app-preview-fixture`
  try {
    await observePreview(page, history.token)
    await updatePreview(task, previewUrl)
    await openTask(page, server.origin, task)
    await expectExecutedPreview(page, previewUrl)

    // Cross-origin policy alone must not mask a missing sandbox restriction.
    expect(new URL(previewUrl).origin).toBe(new URL(page.url()).origin)
    expect(server.previewRequests()).toBe(1)
    expect(await page.evaluate(() => (window as PreviewWindow).previewAccess[0])).toEqual({
      type: 'app-preview-access',
      origin: 'null',
      parentDom: 'SecurityError',
      parentCookie: 'SecurityError',
      parentLocalStorage: 'SecurityError',
      parentSessionStorage: 'SecurityError',
      ownLocalStorage: 'SecurityError',
    })
    // Verify sensitive parent state exists; denied reads cannot pass on empty data.
    expect(await page.evaluate(() => document.cookie.includes('auth_token='))).toBe(true)
    expect(await page.evaluate(() => Boolean(localStorage.getItem('auth_token')))).toBe(true)
    expect(await page.evaluate(() => sessionStorage.getItem('preview-auth-marker'))).toBe(
      'parent-authentication-state'
    )
  } finally {
    await server.close()
  }
})

const unsafeScript = "parent.postMessage({type:'unsafe-preview-executed'}, '*')"
for (const [scheme, unsafeUrl] of [
  ['javascript', `javascript:${unsafeScript}`],
  ['data', `data:text/html,<script>${unsafeScript}</script>`],
]) {
  test(`${scheme} previews never load and replace a running preview without navigation`, async ({
    page,
    history,
    baseURL,
  }) => {
    const team = await history.team(`preview-unsafe-${scheme}`)
    const task = await history.seed(team, 'code')
    const server = await createAppPreviewServer(baseURL!, previewDocument())
    const safeUrl = `${server.origin}/app-preview-fixture`
    const frameNavigations: string[] = []
    page.on('framenavigated', frame => {
      if (frame.parentFrame()) frameNavigations.push(frame.url())
    })
    try {
      await observePreview(page, history.token)
      await updatePreview(task, unsafeUrl)
      await openTask(page, server.origin, task)
      await page.getByRole('button', { name: /^(Preview|预览)$/ }).click()
      await expect(page.getByTestId('app-preview-unavailable')).toBeVisible()
      await expect(page.getByTestId('app-preview-frame')).toHaveCount(0)
      expect(server.previewRequests()).toBe(0)
      expect(await page.evaluate(() => (window as PreviewWindow).unsafePreviewExecutions)).toBe(0)

      // Both updates take the real task-room WebSocket path, without reload.
      await updatePreview(task, safeUrl)
      await expectExecutedPreview(page, safeUrl)
      const handle = await page.getByTestId('app-preview-frame').elementHandle()
      const runningFrame = await handle!.contentFrame()
      expect(runningFrame).not.toBeNull()
      const taskUrl = page.url()
      await updatePreview(task, unsafeUrl)
      await expect(page.getByTestId('app-preview-frame')).toHaveCount(0)
      await expect(page.getByTestId('app-preview-unavailable')).toBeVisible()
      await expect.poll(() => runningFrame!.isDetached()).toBe(true)
      expect(page.url()).toBe(taskUrl)
      expect(checked(await history.api.get(`/api/tasks/${task.id}`))).toMatchObject({
        app: { previewUrl: unsafeUrl },
      })
      expect(server.previewRequests()).toBe(1)
      expect(frameNavigations).toEqual([safeUrl])
      expect(await page.evaluate(() => (window as PreviewWindow).unsafePreviewExecutions)).toBe(0)
    } finally {
      await server.close()
    }
  })
}
