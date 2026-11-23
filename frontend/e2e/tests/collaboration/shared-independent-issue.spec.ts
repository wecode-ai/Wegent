// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { projectTest } from '../../utils/collaboration-project-fixture'
import { REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { webApi } from '../../utils/collaboration-test-support'

const apiOrigin = process.env.E2E_API_URL || 'http://localhost:8000'

projectTest(
  'opens an assigned independent issue from its share link and replies in web collaboration',
  async ({ page, request, browser, scheduledProject }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 830 })
    await page.goto('/collaboration')
    await expect(page.getByTestId('collaboration-primary-issues-assigned')).toBeVisible()
    await expect(page.getByTestId('collaboration-primary-issues-participating')).toBeVisible()
    await expect(page.getByTestId('collaboration-primary-home')).toHaveText(/^(Home|首页)$/)
    const directory = await webApi<{ users: { id: number; user_name: string }[] }>(
      page,
      `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
    )
    const colleague = directory.users.find(user => user.user_name === REGULAR_USER.username)
    expect(colleague, 'The recipient account must exist').toBeDefined()
    await page.getByTestId('collaboration-primary-create-issue').click()
    const participantSearch = page.getByTestId('independent-issue-search-people')
    await expect(participantSearch).toBeFocused()
    await participantSearch.fill(REGULAR_USER.username)
    await expect(page.getByTestId(`independent-issue-invite-${colleague!.id}`)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('web-create-issue.png'), fullPage: true })
    await page.getByTestId('independent-issue-close').click()

    const ownerToken = (await page.context().cookies()).find(
      cookie => cookie.name === 'auth_token'
    )?.value
    expect(ownerToken, 'The sharing account must be authenticated').toBeTruthy()
    const title = `Review shared conversation ${crypto.randomUUID()}`
    const create = await request.post(`${apiOrigin}/api/v1/personal-issues/share`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      multipart: {
        metadata: JSON.stringify({
          request_id: crypto.randomUUID(),
          source: { device_id: 'e2e-desktop', task_id: crypto.randomUUID(), title },
          issue: {
            title,
            description: 'Confirm the reproduction from the shared conversation.',
            participants: [colleague!.id],
            assignee_id: colleague!.id,
          },
        }),
      },
    })
    expect(create.status(), await create.text()).toBe(200)
    const issue = (await create.json()) as { id: string }
    const issuePath = `/api/v1/personal-issues/${encodeURIComponent(issue.id)}`
    const shareLink = `/collaboration/assigned?personalIssueId=${encodeURIComponent(issue.id)}`
    const guest = createApiClient(request)
    const login = await guest.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    expect(login.status).toBe(200)
    const token = login.data!.access_token
    const origin = new URL(page.url()).origin
    const context = await browser.newContext({
      storageState: buildStorageState(origin, token, getJwtExpiryMs(token)),
      viewport: { width: 1280, height: 830 },
    })
    let moved = false
    try {
      const recipientPage = await context.newPage()
      await recipientPage.goto(shareLink)
      const dialog = recipientPage.getByTestId('independent-issue-dialog')
      await expect(
        recipientPage.getByTestId('collaboration-primary-issues-assigned')
      ).toHaveAttribute('aria-current', 'page')
      await expect(
        recipientPage.getByTestId('personal-issues-assigned').getByRole('heading', { level: 1 })
      ).toHaveText(/^(Needs my action|待我处理)$/)
      await expect(recipientPage.getByTestId(`independent-issue-${issue.id}`)).toBeVisible()
      await expect(dialog.getByRole('heading', { name: title })).toBeVisible()
      await expect(dialog).toContainText('Confirm the reproduction')
      const comment = 'Reproduced. I will follow up here.'
      await dialog.getByTestId('independent-issue-comment').fill(comment)
      await dialog.getByTestId('independent-issue-comment-send').click()
      await expect(dialog.locator('article').getByText(comment, { exact: true })).toBeVisible()
      await recipientPage.screenshot({
        path: testInfo.outputPath('web-assigned-issue-detail.png'),
        fullPage: true,
      })
      await recipientPage.setViewportSize({ width: 430, height: 820 })
      await expect(dialog.getByTestId('independent-issue-close')).toBeVisible()
      await expect(recipientPage.getByTestId('personal-issues-assigned')).toBeHidden()
      const mobileDrawer = await dialog.boundingBox()
      expect(mobileDrawer?.width).toBeGreaterThan(400)
      await recipientPage.screenshot({
        path: testInfo.outputPath('web-assigned-issue-mobile.png'),
        fullPage: true,
      })
      await recipientPage.getByTestId('mobile-task-sidebar-toggle').click()
      const mobileAssigned = recipientPage.getByTestId('collaboration-primary-issues-assigned')
      await expect(mobileAssigned).toBeVisible()
      await mobileAssigned.click()
      await expect(dialog).toBeHidden()
      await expect(recipientPage.getByTestId('personal-issues-assigned')).toBeVisible()

      await recipientPage.setViewportSize({ width: 1280, height: 830 })
      await recipientPage.evaluate(() => localStorage.setItem('wegent.theme', 'dark'))
      await recipientPage.reload()
      await expect(recipientPage.locator('html')).toHaveAttribute('data-theme', 'dark')
      await recipientPage.getByTestId('collaboration-primary-create-issue').click()
      const darkModal = recipientPage.locator('body > .collaboration-theme[data-theme="dark"]')
      await expect(darkModal.getByTestId('independent-issue-dialog')).toBeVisible()
      await expect(dialog).toHaveCSS('color-scheme', 'dark')
      await dialog.getByTestId('independent-issue-search-people').fill(REGULAR_USER.username)
      await expect(dialog.getByTestId('issue-participant-results-status')).not.toHaveText(
        /^(Loading participants|正在加载参与人)/
      )
      await recipientPage.screenshot({
        path: testInfo.outputPath('web-create-issue-dark.png'),
        fullPage: true,
      })

      const current = await webApi<{ version: number }>(page, issuePath)
      const projectId = scheduledProject.path.split('/').at(-1)!
      await webApi(page, `${issuePath}/project`, {
        method: 'POST',
        body: { project_id: projectId, version: current.version },
      })
      moved = true
      await recipientPage.goto(shareLink)
      await expect(recipientPage).toHaveURL(
        new RegExp(`${scheduledProject.path}/issues/${issue.id}$`)
      )
      await expect(recipientPage.getByTestId('cloud-todo-detail-title')).toContainText(title)
    } finally {
      await context.close()
      if (!moved) {
        const current = await webApi<{ version: number }>(page, issuePath)
        await webApi(page, issuePath, { method: 'DELETE', body: { version: current.version } })
      }
    }
  }
)
