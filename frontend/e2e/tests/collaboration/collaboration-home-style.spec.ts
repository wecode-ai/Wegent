// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page } from '@playwright/test'
import { webApi } from '../../utils/collaboration-test-support'

interface Resource {
  id: string
  version: number
}

async function archiveResource(page: Page, path: string): Promise<void> {
  const resource = await webApi<Resource>(page, path)
  await webApi(page, `${path}?version=${resource.version}`, { method: 'DELETE' })
}

test('keeps the personal Issue toolbar steady while loading the list', async ({ page }) => {
  let releaseIssues!: () => void
  let requestHeld = false
  const release = new Promise<void>(resolve => {
    releaseIssues = resolve
  })
  await page.route('**/api/v1/cloud-work-items/my-work?*', async route => {
    requestHeld = true
    await release
    await route.continue()
  })

  try {
    await page.goto('/collaboration/assigned', { waitUntil: 'domcontentloaded' })
    await expect
      .poll(() => requestHeld, { message: 'The real personal Issues request is pending' })
      .toBe(true)
    const issues = page.getByTestId('personal-issues-assigned')
    const toolbar = issues.getByTestId('personal-issues-toolbar')
    const sort = toolbar.getByTestId('personal-issues-sort')
    const loadingLabel = /Loading issues…|正在加载 Issue…/
    const indicator = toolbar.getByRole('img', { name: loadingLabel })
    await expect(indicator, 'Pending Issues show a spinner inside the toolbar').toBeVisible({
      timeout: 10_000,
    })
    await expect(issues.getByText(loadingLabel)).toHaveCount(0)
    const pendingSortPosition = await sort.boundingBox()
    expect(pendingSortPosition).not.toBeNull()

    releaseIssues()
    await expect(indicator, 'The spinner disappears when the real request settles').toBeHidden({
      timeout: 10_000,
    })
    expect(await sort.boundingBox()).toEqual(pendingSortPosition)
    await expect(issues.getByRole('alert')).toHaveCount(0)
  } finally {
    releaseIssues()
  }
})

test('renders the collaboration Issue home with the shared visual hierarchy', async ({ page }) => {
  await page.goto('/collaboration')
  await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()

  const suffix = crypto.randomUUID()
  const workspace = await webApi<Resource>(page, '/api/v1/workspaces', {
    method: 'POST',
    body: {
      name: `Issue home style ${suffix}`,
      description: 'Verifies the real collaboration home stylesheet.',
    },
  })
  let project: Resource | undefined

  try {
    project = await webApi<Resource>(page, '/api/v1/cloud-projects', {
      method: 'POST',
      body: {
        workspace_id: workspace.id,
        name: `Issue home project ${suffix}`,
        task_provider: 'local',
        visibility: 'private',
      },
    })

    await page.goto('/collaboration')

    const home = page.getByTestId('collaboration-issue-home')
    const heading = page.getByTestId('collaboration-issue-home-title')
    const subtitle = page.getByTestId('collaboration-issue-home-hint')
    const guide = page.getByTestId('collaboration-issue-guide-1')
    const composer = page.getByTestId('project-chat-composer')
    const projectSelect = page.getByTestId('collaboration-issue-project')

    await expect(home).toBeVisible()
    await expect(home).toHaveCSS('width', '768px')
    await expect(heading).toHaveCSS('font-size', '48px')
    await expect(heading).toHaveCSS('font-weight', '500')
    await expect(subtitle).toHaveCSS('font-size', '16px')
    await expect(guide).toHaveCSS('border-top-width', '0px')
    await expect(guide).toHaveCSS('height', '44px')
    await expect(guide.locator('svg')).toHaveCount(2)
    await expect(composer).toHaveCSS('width', '768px')
    await expect(projectSelect).toBeVisible()
    await projectSelect.click()
    const projectMenu = page.getByTestId('collaboration-issue-project-menu')
    await expect(
      projectMenu.getByRole('option', { name: `Issue home project ${suffix}`, exact: true })
    ).toBeVisible()
  } finally {
    if (project) {
      await archiveResource(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`)
    }
    await archiveResource(page, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}`)
  }
})
