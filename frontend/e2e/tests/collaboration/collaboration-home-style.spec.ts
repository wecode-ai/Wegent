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
    await expect(projectSelect).toHaveCSS('opacity', '0')
    await expect(projectSelect.locator(`option[value="${project.id}"]`)).toHaveText(
      `Issue home project ${suffix}`
    )
  } finally {
    if (project) {
      await archiveResource(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`)
    }
    await archiveResource(page, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}`)
  }
})
