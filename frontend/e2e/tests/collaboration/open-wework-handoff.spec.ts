// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { webApi } from '../../utils/collaboration-test-support'
import { apiData, test as handoffTest } from '../../utils/project-mention-test-support'

const HANDOFF_PATH = '/open-wework?projectId=12&itemId=ISSUE-1'
const EMPTY_STORAGE = { cookies: [], origins: [] }
const DINGTALK_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 AliApp(DingTalk/7.6.0)'
const CHROME_MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36'
const SAFARI_IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'

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
      'wegent://boards/12/issues/ISSUE-1'
    )
    await expect(page.getByTestId('open-wework-button')).toHaveAttribute(
      'data-fallback-url',
      'wework://boards/12/issues/ISSUE-1'
    )
    await expect(page.getByTestId('view-task-button')).toHaveAttribute(
      'href',
      '/collaboration/12/issues/ISSUE-1'
    )
    await expect(page.getByTestId('dingtalk-browser-hint')).toHaveCount(0)
  })
})

test.describe('iPhone system browser handoff page', () => {
  test.use({
    storageState: EMPTY_STORAGE,
    userAgent: SAFARI_IOS_USER_AGENT,
  })

  test('uses the Wework scheme with a compatible mobile fallback', async ({ page }) => {
    await page.goto(HANDOFF_PATH)

    await expect(page.getByTestId('open-wework-button')).toHaveAttribute(
      'href',
      'wework://boards/12/issues/ISSUE-1'
    )
    await expect(page.getByTestId('open-wework-button')).toHaveAttribute(
      'data-fallback-url',
      'wegent://boards/12/issues/ISSUE-1'
    )
  })
})

handoffTest.describe('mobile web session security with real users and Issues', () => {
  handoffTest(
    'does not replace an existing account with a fragment token',
    async ({ context, page, request, mentions }) => {
      await page.goto(mentions.projectPath + `/issues/${mentions.issue.id}`)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      const before = await webApi<{ id: number }>(page, '/api/users/me')
      const beforeCookies = (await context.cookies()).filter(cookie => cookie.name === 'auth_token')
      const login = await createApiClient(request).login(
        REGULAR_USER.username,
        REGULAR_USER.password,
        1
      )
      expect(login.status).toBe(200)
      const injectedToken = login.data!.access_token
      const redirect = `/collaboration/${mentions.project.id}/issues/${mentions.issue.id}`
      await page.goto(
        `/mobile-web-session#token=${encodeURIComponent(injectedToken)}&redirect=${encodeURIComponent(redirect)}`
      )
      await expect(page.getByTestId('mobile-web-session-status')).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('auth_token'))).not.toBe(injectedToken)
      expect((await context.cookies()).filter(cookie => cookie.name === 'auth_token')).toEqual(
        beforeCookies
      )
      expect((await webApi<{ id: number }>(page, '/api/users/me')).id).toBe(before.id)
      await page.goto(redirect)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    }
  )

  handoffTest(
    'binds one-time grants to identity, nonce and the real Issue destination',
    async ({ page, mentions }) => {
      const redirect = `/collaboration/${mentions.project.id}/issues/${mentions.issue.id}`
      const nonce = crypto.randomUUID().replaceAll('-', '').repeat(2)
      const grant = await apiData(
        mentions.api.post<{ code: string; user_id: number }>('/api/auth/wework/web-sessions', {
          nonce,
          redirect,
        })
      )
      expect(grant.user_id).toBe(mentions.actor.id)
      const otherLogin = await apiData(
        mentions.recipientApi.login(mentions.recipient.user_name, mentions.recipientPassword, 1)
      )
      const conflicting = await mentions.api.post('/api/auth/wework/web-sessions/exchange', {
        code: grant.code,
        nonce,
        redirect,
        existing_tokens: [otherLogin.access_token],
      })
      expect(conflicting.status).toBe(409)
      const fresh = await apiData(
        mentions.api.post<{ code: string }>('/api/auth/wework/web-sessions', { nonce, redirect })
      )
      const wrongNonce = await mentions.api.post('/api/auth/wework/web-sessions/exchange', {
        code: fresh.code,
        nonce: crypto.randomUUID().replaceAll('-', '').repeat(2),
        redirect,
        existing_tokens: [],
      })
      expect(wrongNonce.status).toBe(403)
      const valid = await apiData(
        mentions.api.post<{ code: string }>('/api/auth/wework/web-sessions', { nonce, redirect })
      )
      const body = { code: valid.code, nonce, redirect, existing_tokens: [] }
      const exchange = await apiData(
        mentions.api.post<{ access_token: string; user_id: number }>(
          '/api/auth/wework/web-sessions/exchange',
          body
        )
      )
      expect(exchange.user_id).toBe(mentions.actor.id)
      const currentUser = await createApiClient(
        page.request,
        undefined,
        exchange.access_token
      ).get<{
        id: number
      }>('/api/users/me')
      expect(currentUser.data?.id).toBe(exchange.user_id)
      expect((await mentions.api.post('/api/auth/wework/web-sessions/exchange', body)).status).toBe(
        410
      )
      expect(
        (await mentions.recipientApi.get(`/api/v1/cloud-projects/${mentions.project.id}`)).status
      ).toBe(403)
      await page.goto(redirect)
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    }
  )

  handoffTest(
    'rejects an expired grant and recovers with a fresh authorized grant',
    async ({ mentions, request }) => {
      handoffTest.setTimeout(100_000)
      const redirect = `/collaboration/${mentions.project.id}/issues/${mentions.issue.id}`
      const nonce = crypto.randomUUID().replaceAll('-', '').repeat(2)
      const expired = await apiData(
        mentions.api.post<{ code: string; expires_at: number }>('/api/auth/wework/web-sessions', {
          nonce,
          redirect,
        })
      )
      const waitMs = expired.expires_at * 1000 - Date.now() + 1000
      expect(waitMs).toBeGreaterThan(0)
      expect(waitMs).toBeLessThan(65_000)
      // Let the real Redis TTL expire. Altering the browser clock cannot expire a server grant.
      await new Promise(resolve => setTimeout(resolve, waitMs))
      expect(
        (
          await mentions.api.post('/api/auth/wework/web-sessions/exchange', {
            code: expired.code,
            nonce,
            redirect,
            existing_tokens: [],
          })
        ).status
      ).toBe(410)
      const fresh = await apiData(
        mentions.api.post<{ code: string }>('/api/auth/wework/web-sessions', { nonce, redirect })
      )
      const recovered = await apiData(
        mentions.api.post<{ access_token: string; user_id: number }>(
          '/api/auth/wework/web-sessions/exchange',
          { code: fresh.code, nonce, redirect, existing_tokens: [] }
        )
      )
      const recoveredApi = createApiClient(request, undefined, recovered.access_token)
      expect((await recoveredApi.get<{ id: number }>('/api/users/me')).data?.id).toBe(
        mentions.actor.id
      )
      expect(
        (await recoveredApi.get(`/api/v1/cloud-projects/${mentions.project.id}/loop-items`)).status
      ).toBe(200)
    }
  )
})

handoffTest.describe('iPhone browser real Issue fallback', () => {
  handoffTest.use({ userAgent: SAFARI_IOS_USER_AGENT, viewport: { width: 390, height: 844 } })

  handoffTest(
    'clicks through to the authenticated Issue and focuses its persisted comment',
    async ({ page, mentions }) => {
      const marker = `iPhone mentioned comment ${crypto.randomUUID()}`
      const comment = await mentions.chat().send({
        projectId: mentions.project.id,
        taskId: mentions.issue.id,
        clientMessageId: crypto.randomUUID(),
        text: marker,
      })
      await page.goto(
        `/open-wework?projectId=${mentions.project.id}&itemId=${mentions.issue.id}&commentId=${comment.messageId}`
      )
      await page.getByTestId('view-task-button').click()
      await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
      const target = page.locator(`[data-message-id="${comment.messageId}"]`)
      await expect(target).toContainText(marker)
      await expect(target).toHaveAttribute('data-flash', 'true')
      await expect(target).toBeInViewport()
      expect((await webApi<{ id: number }>(page, '/api/users/me')).id).toBe(mentions.actor.id)
    }
  )
})

test.describe('untrusted mobile session URLs', () => {
  test.use({ storageState: EMPTY_STORAGE })

  test('rejects an external redirect without writing a token', async ({ page }) => {
    await page.goto(
      `/mobile-web-session#token=test-token&redirect=${encodeURIComponent(
        'https://evil.example/steal'
      )}`
    )

    await expect(page.getByTestId('mobile-web-session-status')).toBeVisible()
    expect(await page.evaluate(() => window.localStorage.getItem('auth_token'))).toBeNull()
  })
})
