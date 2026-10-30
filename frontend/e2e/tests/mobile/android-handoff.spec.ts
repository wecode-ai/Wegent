// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { _android, expect, type AndroidDevice, type Page } from '@playwright/test'
import { apiData, test } from '../../utils/project-mention-test-support'

const PACKAGE = 'com.wecode.wegent'
const APP_LINK_HOST = 'mobile.e2e.invalid'

async function openLink(device: AndroidDevice, url: string): Promise<void> {
  // Package selection still requires the real manifest's matching intent filter.
  // Domain association hosting is deployment configuration, outside this local fixture.
  const output = await device.shell(
    `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d '${url}' -p ${PACKAGE}`
  )
  expect(output.toString()).not.toMatch(/Error:|unable to resolve Intent/)
}

async function expectFocusedComment(page: Page, commentId: string, text: string) {
  const comment = page.locator(`[data-message-id="${commentId}"]`)
  await expect(comment).toContainText(text)
  await expect(comment).toHaveAttribute('data-flash', 'true')
  await expect(comment).toBeInViewport()
  await expect(comment).not.toHaveAttribute('data-flash', 'true')
}

test('real Android cold and running App links authorize, display and focus the persisted Issue', async ({
  mentions,
}, testInfo) => {
  test.setTimeout(240_000)
  const devices = await _android.devices()
  expect(
    devices,
    'Start exactly one Android emulator; native coverage must never silently skip'
  ).toHaveLength(1)
  const device = devices[0]
  device.setDefaultTimeout(30_000)
  await mentions.grant('direct', 'Developer')
  const marker = `Native comment ${crypto.randomUUID()}`
  const comment = await mentions.chat().send({
    projectId: mentions.project.id,
    taskId: mentions.issue.id,
    clientMessageId: crypto.randomUUID(),
    text: marker,
  })
  await mentions.chat().send({
    projectId: mentions.project.id,
    taskId: mentions.issue.id,
    clientMessageId: crypto.randomUUID(),
    text: Array.from({ length: 45 }, (_, index) => `Later persisted line ${index}`).join('\n\n'),
  })
  expect((await mentions.messages(mentions.issue.id)).map(message => message.messageId)).toContain(
    comment.messageId
  )
  const scheme = `wework://boards/${mentions.project.id}/issues/${mentions.issue.id}/comments/${comment.messageId}`
  const https = `https://${APP_LINK_HOST}/open-wework?projectId=${mentions.project.id}&itemId=${mentions.issue.id}&commentId=${comment.messageId}`
  const chrome = await device.launchBrowser()
  try {
    await test.step('Authorize the installed App through its real browser approval flow', async () => {
      await device.shell(`am force-stop ${PACKAGE}`)
      await device.shell(`am start -W -n ${PACKAGE}/.MainActivity`)
      const authorizationPage = chrome.waitForEvent('page')
      await device.tap({ res: 'authorize-login' })
      const browserPage = await authorizationPage
      await expect(browserPage.locator('input[name="user_name"]')).toBeVisible()
      await browserPage.locator('input[name="user_name"]').fill(mentions.recipient.user_name)
      await browserPage.locator('input[name="password"]').fill(mentions.recipientPassword)
      await browserPage.locator('button[type="submit"]').click()
      await expect(browserPage).toHaveURL(/\/auth\/wework\/authorize\?session_id=/)
      await browserPage.getByRole('button', { name: /^(Authorize|授权)$/ }).click()
      await device.shell(`am start -W -n ${PACKAGE}/.MainActivity`)
      await device.wait({ res: 'device-carousel' })
    })

    let webPage!: Page
    await test.step('Cold start receives the scheme comment and renders the authorized WebView', async () => {
      await device.shell(`am force-stop ${PACKAGE}`)
      await openLink(device, scheme)
      webPage = await (await device.webView({ pkg: PACKAGE })).page()
      await expect(webPage.getByTestId('collaboration-issue-detail')).toBeVisible()
      await expect(webPage).toHaveURL(new RegExp(`/issues/${mentions.issue.id}\\?commentId=`))
      expect(new URL(webPage.url()).searchParams.get('commentId')).toBe(comment.messageId)
      await expectFocusedComment(webPage, comment.messageId, marker)
      const account = await webPage.evaluate(async () => {
        const response = await fetch('/api/users/me')
        return { status: response.status, user: await response.json() }
      })
      expect(account.status).toBe(200)
      expect(account.user.id).toBe(mentions.recipient.id)
    })

    await test.step('The running App receives HTTPS and refocuses the same comment', async () => {
      const previousRequest = new URL(webPage.url()).searchParams.get('focusRequest')
      await openLink(device, https)
      await expect
        .poll(() => new URL(webPage.url()).searchParams.get('focusRequest'))
        .not.toBe(previousRequest)
      await expectFocusedComment(webPage, comment.messageId, marker)
    })

    await test.step('A lost Web session refreshes through the real native credential', async () => {
      await webPage.context().clearCookies()
      await webPage.evaluate(() => {
        localStorage.removeItem('auth_token')
        localStorage.removeItem('auth_token_expire')
      })
      await webPage.reload()
      const replacement = webPage.context().waitForEvent('page')
      await device.tap({ res: 'web-issue-reauthorize' })
      webPage = await replacement
      await expect(webPage.getByTestId('collaboration-issue-detail')).toBeVisible()
      await expectFocusedComment(webPage, comment.messageId, marker)
    })

    await test.step('Revoked access is rejected by the real project API and WebView', async () => {
      expect(
        (
          await mentions.api.delete(
            `/api/v1/cloud-projects/${mentions.project.id}/members/${mentions.recipient.id}`
          )
        ).status
      ).toBe(204)
      expect(
        (await mentions.recipientApi.get(`/api/v1/cloud-projects/${mentions.project.id}`)).status
      ).toBe(403)
      const denied = webPage.waitForResponse(
        response =>
          response.url().includes(`/cloud-projects/${mentions.project.id}`) &&
          response.status() === 403
      )
      await openLink(device, scheme)
      await denied
      await expect(webPage.getByTestId('collaboration-issue-detail')).toHaveCount(0)
      await expect(webPage.getByTestId('collaboration-error')).toBeVisible()
      await apiData(mentions.recipientApi.get('/api/users/me'))
    })
  } finally {
    await testInfo.attach('android-device', {
      body: Buffer.from(JSON.stringify({ model: device.model(), serial: device.serial() })),
      contentType: 'application/json',
    })
    await chrome.close()
    await device.close()
  }
})
