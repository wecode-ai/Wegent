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

test('renders the shared personal home and a continuous collaboration sidebar', async ({
  page,
}, testInfo) => {
  const evidence = async (name: string) => {
    if (process.env.E2E_HOME_SCREENSHOTS === '1') {
      await page.screenshot({
        path: testInfo.outputPath(name + '.png'),
        animations: 'disabled',
        style: 'nextjs-portal { visibility: hidden }',
      })
    }
  }
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

    const home = page.getByTestId('personal-home')
    const items = home.getByTestId('personal-home-items-region')
    const heading = items.getByRole('heading', { level: 1 })
    const composer = items.getByTestId('personal-home-create').getByTestId('project-chat-composer')
    const projectSelect = items.getByTestId('collaboration-issue-project')

    await expect(home).toBeVisible()
    await expect(composer).toBeVisible()
    await expect(heading).toHaveCSS('font-size', '20px')
    await expect(heading).toHaveCSS('font-weight', '500')
    await expect(items.getByTestId('personal-home-scope-assigned')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(items.getByTestId('personal-home-sort')).toBeVisible()
    await expect(items.getByTestId('personal-home-filter')).toBeVisible()

    const sidebar = page.getByTestId('collaboration-context-sidebar')
    const navigation = sidebar.locator('.collaboration-platform-sidebar')
    await expect(sidebar).toHaveCSS('border-right-width', '1px')
    await expect(navigation).toHaveCSS('border-right-width', '0px')
    await expect(navigation).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    expect((await sidebar.boundingBox())?.x).toBe(0)
    const surfaces = await sidebar.evaluate(element => [
      getComputedStyle(element).backgroundColor,
      getComputedStyle(element.closest('.smart-h-screen')!).backgroundColor,
    ])
    expect(surfaces[0]).not.toBe(surfaces[1])

    await expect(projectSelect).toBeVisible()
    await projectSelect.click()
    const projectMenu = page.getByTestId('collaboration-issue-project-menu')
    await expect(
      projectMenu.getByRole('option', { name: `Issue home project ${suffix}`, exact: true })
    ).toBeVisible()
    await projectMenu
      .getByRole('option', { name: 'Issue home project ' + suffix, exact: true })
      .click()

    await test.step('Record is the default, and switching to task mode keeps the draft', async () => {
      const record = items.getByTestId('personal-home-record-mode')
      const task = items.getByTestId('personal-home-new-issue')
      const input = items.getByTestId('collaboration-home-issue-content')
      await expect(record).toHaveText(/^(Record an issue|记录事项)$/)
      await expect(task).toHaveText(/Create task|创建任务/i)
      await expect(record).toHaveAttribute('aria-selected', 'true', { timeout: 8_000 })
      await expect(items).toHaveAttribute('aria-busy', 'false')
      await evidence('01-collaboration-home')
      await items.getByTestId('personal-home-scope-participating').click()
      await expect(items.getByTestId('personal-home-scope-participating')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await input.fill('Review handoff with the project team')
      await expect(input).toContainText('Review handoff with the project team')
      await evidence('02-record-draft')
      await task.click()
      await expect(task).toHaveAttribute('aria-selected', 'true', { timeout: 8_000 })
      await expect(items.getByTestId('personal-home-task-content')).toContainText(
        'Review handoff with the project team',
        { timeout: 8_000 }
      )
      await expect(items.getByTestId('personal-home-task-execution-settings')).toHaveAttribute(
        'aria-busy',
        'false',
        { timeout: 8_000 }
      )
      await evidence('03-task-mode-retains-draft')
      await record.click()
      await expect(input).toContainText('Review handoff with the project team', { timeout: 8_000 })
    })

    await test.step('Recording opens details on the same page and keeps the current list', async () => {
      const title = 'Review handoff with the project team'
      const save = page.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/loop-items',
        { timeout: 10_000 }
      )
      await items.getByTestId('collaboration-home-create-issue').click()
      const response = await save
      expect(response.ok(), await response.text()).toBe(true)
      const detail = home.getByTestId('personal-issues-detail')
      await expect(detail.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 8_000 })
      await expect(page).toHaveURL(/\/collaboration$/)
      await expect(items.getByTestId('personal-home-scope-participating')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(items.getByText(/^(Inbox|收集箱)$/)).toBeVisible()
      await evidence('04-recorded-issue-detail')

      await page.setViewportSize({ width: 390, height: 844 })
      const back = detail.getByTestId('personal-home-back-to-issues')
      await expect(back).toBeVisible({ timeout: 8_000 })
      await expect(items).toBeHidden()
      await evidence('05-mobile-issue-detail')
      await back.click()
      await expect(detail).toBeHidden({ timeout: 8_000 })
      await expect(items.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 8_000 })
      await evidence('06-mobile-back-to-list')
    })
  } finally {
    if (project) {
      await archiveResource(page, `/api/v1/cloud-projects/${encodeURIComponent(project.id)}`)
    }
    await archiveResource(page, `/api/v1/workspaces/${encodeURIComponent(workspace.id)}`)
  }
})
