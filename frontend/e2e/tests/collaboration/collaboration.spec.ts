// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

test.describe('Collaboration module', () => {
  let projectId = ''

  test.afterEach(async ({ page }) => {
    if (!projectId) return
    const cleanup = await page.evaluate(async id => {
      const projectResponse = await fetch(`/api/v1/cloud-projects/${encodeURIComponent(id)}`)
      if (!projectResponse.ok) {
        return { ok: false, status: projectResponse.status, stage: 'get' }
      }
      const project = (await projectResponse.json()) as { version: number }
      const response = await fetch(
        `/api/v1/cloud-projects/${encodeURIComponent(id)}?version=${project.version}`,
        { method: 'DELETE' }
      )
      return { ok: response.ok, status: response.status, stage: 'delete' }
    }, projectId)
    expect(cleanup, `Failed to archive E2E project during ${cleanup.stage}`).toEqual({
      ok: true,
      status: 204,
      stage: 'delete',
    })
    projectId = ''
  })

  test('replaces the sidebar TODO entry and preserves the legacy inbox route', async ({ page }) => {
    await page.goto('/inbox', { waitUntil: 'commit' })
    const moreButton = page.getByTestId('task-sidebar-more-button')
    await expect(moreButton).toBeVisible()
    await moreButton.hover()
    await page.getByTestId('task-sidebar-more-collaboration-button').click()

    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId('collaboration-root')).toBeVisible()

    await page.goto('/inbox', { waitUntil: 'commit' })
    const legacyInboxNotice = page.getByTestId('legacy-inbox-notice')
    await expect(legacyInboxNotice).toBeVisible()
    await legacyInboxNotice.getByRole('link').click()
    await expect(page).toHaveURL(/\/collaboration$/)
  })

  test('creates, updates, comments on, and moves an Issue through the real backend', async ({
    page,
  }) => {
    const suffix = `${Date.now()}`
    const projectName = `Collaboration E2E ${suffix}`
    const issueTitle = `Shared Issue ${suffix}`

    await page.goto('/collaboration')
    await page.getByTestId('collaboration-project-create').click()
    await expect(page.getByTestId('collaboration-project-location-local')).toHaveCount(0)
    await page.getByTestId('collaboration-project-name-input').fill(projectName)
    await page
      .getByTestId('collaboration-project-description-input')
      .fill('Web and Wework share this collaboration core.')
    await page.getByTestId('collaboration-project-create-confirm').click()

    await expect(page).toHaveURL(/\/collaboration\/[^/?]+$/)
    projectId = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '')
    expect(projectId).not.toBe('')
    await expect(page.getByTestId('collaboration-board')).toBeVisible()

    await page.getByTestId('collaboration-issue-create').click()
    await page.getByTestId('cloud-todo-title').fill(issueTitle)
    await page
      .getByTestId('cloud-todo-detail-description')
      .fill('Initial collaboration description.')
    await page.getByTestId('cloud-todo-create-confirm').click()

    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    const issuePath = new URL(page.url()).pathname
    const issueId = decodeURIComponent(issuePath.split('/').at(-1) ?? '')
    expect(issueId).not.toBe('')

    await page.getByTestId('cloud-todo-detail-title').fill(`${issueTitle} updated`)
    await page.getByTestId('cloud-todo-save').click()
    await page.getByTestId('collaboration-issue-comment').fill('Persistent E2E comment')
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText('Persistent E2E comment')

    await page.getByTestId('cloud-todo-detail-status').selectOption('pending')
    await page.getByTestId('cloud-todo-save').click()
    await page.getByTestId('cloud-todo-detail-close').click()
    await expect(page).toHaveURL(new RegExp(`/collaboration/${encodeURIComponent(projectId)}$`))
    await expect(page.getByTestId('cloud-todo-column-pending')).toContainText(
      `${issueTitle} updated`
    )

    await page.reload()
    await expect(page.getByTestId('cloud-todo-column-pending')).toContainText(
      `${issueTitle} updated`
    )
    await page.getByTestId(`collaboration-issue-${issueId}`).getByRole('button').first().click()
    await expect(page.getByTestId('collaboration-comments')).toContainText('Persistent E2E comment')
  })
})
