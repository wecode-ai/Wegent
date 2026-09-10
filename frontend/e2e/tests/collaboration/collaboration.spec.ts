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
    await page.goto('/tasks')
    await page.getByTestId('task-sidebar-nav-collaboration-button').click()

    await expect(page).toHaveURL(/\/collaboration$/)
    await expect(page.getByTestId('collaboration-root')).toBeVisible()

    await page.goto('/inbox')
    await expect(page.getByTestId('legacy-inbox-notice')).toBeVisible()
    await page.getByTestId('legacy-inbox-notice').getByRole('link').click()
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
    await page.getByTestId('collaboration-issue-title-input').fill(issueTitle)
    await page
      .getByTestId('collaboration-issue-description-input')
      .fill('Initial collaboration description.')
    await page.getByTestId('collaboration-issue-create-confirm').click()

    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    const issuePath = new URL(page.url()).pathname
    const issueId = decodeURIComponent(issuePath.split('/').at(-1) ?? '')
    expect(issueId).not.toBe('')

    await page.getByTestId('collaboration-issue-detail-title').fill(`${issueTitle} updated`)
    await page.getByTestId('collaboration-issue-save').click()
    await page.getByTestId('collaboration-issue-comment').fill('Persistent E2E comment')
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText('Persistent E2E comment')

    await page.getByTestId('collaboration-issue-close').click()
    await page.getByTestId(`collaboration-issue-${issueId}-move-right`).click()
    await expect(page.getByTestId('collaboration-column-pending')).toContainText(
      `${issueTitle} updated`
    )

    await page.reload()
    await expect(page.getByTestId('collaboration-column-pending')).toContainText(
      `${issueTitle} updated`
    )
    await page.getByTestId(`collaboration-issue-${issueId}`).getByRole('button').first().click()
    await expect(page.getByTestId('collaboration-comments')).toContainText('Persistent E2E comment')

    await page.getByTestId('collaboration-issue-close').click()
    await page.getByTestId('collaboration-tab-members').click()
    const agentName = `Shared bot ${suffix}`
    await page.getByTestId('collaboration-agent-create').click()
    await page.getByTestId('collaboration-agent-name').fill(agentName)
    await page.getByTestId('collaboration-agent-capability').fill('Handle repository checks')
    await page.getByTestId('collaboration-agent-prompt').fill('Investigate and report failures.')
    await page.getByTestId('collaboration-agent-save').click()
    await expect(page.getByTestId('collaboration-members')).toContainText(agentName)

    await page.getByTestId('collaboration-tab-automation').click()
    await expect(page.getByTestId('collaboration-automation')).toBeVisible()
    await page.getByTestId('automation-create-rule').click()
    await page.getByTestId('automation-editor-name-input').fill(`Checks failed ${suffix}`)
    await page.getByTestId('automation-rule-description').fill('Create an Issue for failed checks.')
    await page.getByTestId('automation-trigger-type').selectOption('event')
    await page
      .getByTestId('automation-external-event-type')
      .selectOption('change_request.checks_failed')
    await page.getByTestId('event-subscription-add').click()
    await page.getByTestId('event-subscription-name').fill(`GitHub ${suffix}`)
    await page
      .getByTestId('event-subscription-resource-url')
      .fill('https://github.com/acme/collaboration-e2e')
    await page.getByTestId('event-subscription-save').click()
    await page.getByTestId('automation-agent').selectOption({ label: agentName })
    await page.getByTestId('automation-save').click()
    await expect(page.getByTestId('collaboration-automation')).toContainText(
      `Checks failed ${suffix}`
    )

    const automationSnapshot = await page.evaluate(async id => {
      const [rulesResponse, hooksResponse] = await Promise.all([
        fetch(`/api/v1/cloud-projects/${encodeURIComponent(id)}/automations`),
        fetch(`/api/v1/cloud-projects/${encodeURIComponent(id)}/incoming-hooks`),
      ])
      return {
        rules: await rulesResponse.json(),
        hooks: await hooksResponse.json(),
      }
    }, projectId)
    expect(automationSnapshot.hooks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: `GitHub ${suffix}` })])
    )
    expect(automationSnapshot.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: `Checks failed ${suffix}`,
          eventType: 'change_request.checks_failed',
          eventConfig: expect.objectContaining({
            execution_target: 'create_issue',
          }),
        }),
      ])
    )
  })
})
