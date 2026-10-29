// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'

const HANDOFF_PATH = '/open-wework?projectId=12&itemId=ISSUE-1'
const EMPTY_STORAGE = { cookies: [], origins: [] }
const DINGTALK_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 AliApp(DingTalk/7.6.0)'
const CHROME_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36'

test.describe('DingTalk handoff page', () => {
  test.use({
    locale: 'zh-CN',
    storageState: EMPTY_STORAGE,
    userAgent: DINGTALK_MOBILE_USER_AGENT,
  })

  test('renders static instructions without requesting the Next.js runtime', async ({ page }) => {
    const nextRequests: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/_next/')) {
        nextRequests.push(request.url())
      }
    })

    await page.goto(HANDOFF_PATH)

    await expect(page.getByTestId('dingtalk-browser-hint')).toBeVisible()
    await expect(page.getByRole('heading', { name: '请在浏览器中打开' })).toBeVisible()
    await expect(
      page.getByTestId('dingtalk-browser-hint').getByText('选择「在浏览器打开」')
    ).toBeVisible()
    await expect(page.getByTestId('open-wework-button')).toHaveCount(0)
    await expect(page.getByTestId('view-task-button')).toHaveAttribute(
      'href',
      '/collaboration/12/issues/ISSUE-1'
    )
    expect(nextRequests).toEqual([])
  })

  test('does not render navigation actions for an invalid destination', async ({ page }) => {
    await page.goto('/open-wework?projectId=12&redirect=https%3A%2F%2Fevil.example')

    await expect(page.getByRole('heading', { name: '链接无效' })).toBeVisible()
    await expect(page.getByTestId('open-wework-button')).toHaveCount(0)
    await expect(page.getByTestId('view-task-button')).toHaveCount(0)
  })
})

test.describe('system browser handoff page', () => {
  test.use({
    storageState: EMPTY_STORAGE,
    userAgent: CHROME_MOBILE_USER_AGENT,
  })

  test('offers the Wework scheme and web fallback', async ({ page }) => {
    await page.goto(HANDOFF_PATH)

    await expect(page.getByTestId('open-wework-button')).toHaveAttribute(
      'href',
      'wework://boards/12/issues/ISSUE-1'
    )
    await expect(page.getByTestId('view-task-button')).toHaveAttribute(
      'href',
      '/collaboration/12/issues/ISSUE-1'
    )
    await expect(page.getByTestId('dingtalk-browser-hint')).toHaveCount(0)
  })
})

test.describe('mobile web session bootstrap', () => {
  test.use({ storageState: EMPTY_STORAGE })

  test('stores the access token before redirecting to the Issue', async ({ context, page }) => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
    const token = jwtWithExpiry(expiresAtSeconds)
    await page.route('**/collaboration/12/issues/ISSUE-1', route =>
      route.fulfill({
        body: '<h1 id="redirected-issue">Issue loaded</h1>',
        contentType: 'text/html',
        status: 200,
      })
    )

    await page.goto(
      `/mobile-web-session#token=${encodeURIComponent(
        token
      )}&redirect=${encodeURIComponent('/collaboration/12/issues/ISSUE-1')}`
    )

    await expect(page.locator('#redirected-issue')).toBeVisible()
    await expect(page).toHaveURL(/\/collaboration\/12\/issues\/ISSUE-1$/)
    expect(await page.evaluate(() => window.localStorage.getItem('auth_token'))).toBe(token)
    expect(await page.evaluate(() => window.localStorage.getItem('auth_token_expire'))).toBe(
      String(expiresAtSeconds * 1000)
    )
    expect((await context.cookies()).some(cookie => cookie.name === 'auth_token')).toBe(true)
  })

  test('rejects an external redirect without writing a token', async ({ page }) => {
    await page.goto(
      `/mobile-web-session#token=test-token&redirect=${encodeURIComponent(
        'https://evil.example/steal'
      )}`
    )

    await expect(page.getByText('链接无效，请返回 Wework 重新打开。')).toBeVisible()
    expect(await page.evaluate(() => window.localStorage.getItem('auth_token'))).toBeNull()
  })
})

function jwtWithExpiry(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return `${header}.${payload}.signature`
}
