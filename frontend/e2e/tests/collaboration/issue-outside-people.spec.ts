// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { projectTest, type Resource } from '../../utils/collaboration-project-fixture'
import { webApi, writeSharedComposer } from '../../utils/collaboration-test-support'
import { REGULAR_USER } from '../../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { createApiClient } from '../../utils/api-client'

projectTest(
  'invites and assigns an outsider with confirmation and revocable Issue-only management',
  async ({ page, request, browser, scheduledProject: { path, issueId } }, testInfo) => {
    testInfo.setTimeout(120_000)
    const projectId = path.split('/').at(-1)!
    const issuePath = `/api/v1/loop-items/${issueId}`
    const projectPath = `/api/v1/cloud-projects/${projectId}`
    const users = await webApi<{ users: Array<{ id: number; user_name: string }> }>(
      page,
      `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
    )
    const outsider = users.users.find(user => user.user_name === REGULAR_USER.username)!
    expect(outsider).toBeDefined()
    const initial = await webApi<Resource>(page, issuePath)
    await webApi(page, issuePath, {
      method: 'PATCH',
      body: { version: initial.version, assignee_user_id: null },
    })
    await webApi(page, `${projectPath}/members/${outsider.id}`, { method: 'DELETE' })
    const sibling = await webApi<Resource>(page, `${projectPath}/loop-items`, {
      method: 'POST',
      body: { title: `Unshared sibling ${crypto.randomUUID()}` },
    })
    const guest = createApiClient(request)
    const login = await guest.login(REGULAR_USER.username, REGULAR_USER.password, 1)
    expect(login.status).toBe(200)
    expect((await guest.get(issuePath)).status).toBe(404)
    await page.goto(path)
    await page.getByTestId(`cloud-todo-card-${issueId}`).click()
    await page.getByTestId('cloud-todo-add-collaborator').click()
    const members = await webApi<Array<{ user_id: number; user_name: string }>>(
      page,
      `${projectPath}/members`
    )
    const owner = members.find(member => member.user_id !== outsider.id)!
    expect(owner).toBeDefined()
    await page.getByTestId(`cloud-todo-collaborator-option-${owner.user_id}`).click()
    const search = page.getByTestId('cloud-todo-collaborator-select')
    await expect(search).toHaveJSProperty('tagName', 'INPUT')
    await search.fill(outsider.user_name)
    const result = page.getByTestId(`cloud-todo-collaborator-option-${outsider.id}`)
    await expect(result).toContainText(/非项目成员|Outside this project/)
    await page.screenshot({
      path: testInfo.outputPath('outside-people-search.png'),
      fullPage: true,
    })
    await result.click()
    await page.getByTestId('cloud-todo-confirm-collaborator').click()
    await page.getByTestId('issue-outside-collaborator-cancel').click()
    expect((await guest.get(issuePath)).status).toBe(404)
    await page.getByTestId('cloud-todo-confirm-collaborator').click()
    await page.getByTestId('issue-outside-collaborator-confirm').click()
    await expect.poll(async () => (await guest.get(issuePath)).status).toBe(200)
    const invited = await guest.get<Resource & { invited_only: boolean }>(issuePath)
    expect(invited.data!.invited_only).toBe(true)
    expect((await guest.get(projectPath)).status).toBe(404)
    expect((await guest.get(`/api/v1/loop-items/${sibling.id}`)).status).toBe(404)
    expect(
      (
        await guest.patch(issuePath, {
          version: invited.data!.version,
          title: 'Managed by invited participant',
        })
      ).status
    ).toBe(200)
    const guestContext = await browser.newContext({
      storageState: buildStorageState(
        new URL(page.url()).origin,
        login.data!.access_token,
        getJwtExpiryMs(login.data!.access_token)
      ),
    })
    try {
      const guestPage = await guestContext.newPage()
      await guestPage.goto(page.url())
      await expect(guestPage.getByTestId('cloud-todo-add-collaborator')).toBeEnabled()
      await expect(guestPage.getByTestId('cloud-todo-detail-assignee')).toBeEnabled()
      const comment = `Invited participant comment ${crypto.randomUUID()}`
      await writeSharedComposer(guestPage.getByTestId('collaboration-issue-comment'), comment)
      await guestPage.getByTestId('collaboration-issue-comment-submit').click()
      await expect(guestPage.getByTestId('collaboration-comments')).toContainText(comment)
      await guestPage.reload()
      await expect(guestPage.getByTestId('collaboration-comments')).toContainText(comment)
      await guestPage.screenshot({
        path: testInfo.outputPath('invited-issue-desktop.png'),
        fullPage: true,
      })
      await guestPage.setViewportSize({ width: 390, height: 844 })
      await expect(guestPage.getByTestId('cloud-todo-add-collaborator')).toBeVisible()
      expect(
        await guestPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      await guestPage.screenshot({
        path: testInfo.outputPath('invited-issue-mobile.png'),
        fullPage: true,
      })
      const current = await guest.get<Resource>(issuePath)
      expect(
        (
          await guest.post(`${projectPath}/loop-items/${issueId}/assign`, {
            version: current.data!.version,
            assignee_type: 'user',
            assignee_id: String(owner.user_id),
            notify_assignee: false,
          })
        ).status
      ).toBe(200)
      expect((await guest.delete(`${issuePath}/collaborators/${owner.user_id}`)).status).toBe(204)
      await guestPage.reload()
      await guestPage.getByTestId('cloud-todo-add-collaborator').click()
      await guestPage.getByTestId('cloud-todo-collaborator-select').fill(owner.user_name)
      await guestPage.getByTestId(`cloud-todo-collaborator-option-${owner.user_id}`).click()
      await guestPage.getByTestId('cloud-todo-confirm-collaborator').click()
      await guestPage.getByTestId('issue-outside-collaborator-confirm').click()
      await expect
        .poll(async () =>
          (await guest.get<Array<{ user_id: number }>>(`${issuePath}/collaborators`)).data!.some(
            user => user.user_id === owner.user_id
          )
        )
        .toBe(true)
    } finally {
      await guestContext.close()
    }
    await page.reload()
    await page.getByTestId(`cloud-todo-card-${issueId}`).click()
    await page
      .getByRole('button', {
        name: new RegExp(`移除参与者.*${outsider.user_name}|Remove.*${outsider.user_name}`),
      })
      .click()
    await expect.poll(async () => (await guest.get(issuePath)).status).toBe(404)
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId('cloud-todo-detail-assignee-search').fill(outsider.user_name)
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${outsider.id}`).click()
    await page.getByTestId('issue-outside-assignee-cancel').click()
    expect((await guest.get(issuePath)).status).toBe(404)
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId('cloud-todo-detail-assignee-search').fill(outsider.user_name)
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${outsider.id}`).click()
    await page.getByTestId('issue-outside-assignee-confirm').click()
    await expect.poll(async () => (await guest.get(issuePath)).status).toBe(200)
    expect((await guest.get(projectPath)).status).toBe(404)
    await page.screenshot({ path: testInfo.outputPath('outside-assignee.png'), fullPage: true })
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId('cloud-todo-detail-assignee-option-empty').click()
    await expect.poll(async () => (await guest.get(issuePath)).status).toBe(404)
  }
)
