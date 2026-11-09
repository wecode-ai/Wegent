import { expect } from '@playwright/test'
import { projectTest } from '../../utils/collaboration-project-fixture'

const webViews = [
  ['board', 'collaboration-tab-board', 'collaboration-board'],
  ['calendar', 'collaboration-calendar-tab', 'collaboration-calendar'],
  ['gantt', 'collaboration-gantt-tab', 'collaboration-gantt'],
  ['table', 'collaboration-tab-table', 'collaboration-issue-table-search'],
  ['files', 'collaboration-tab-files', 'cloud-files-view'],
  ['manage', 'collaboration-tab-manage', 'project-settings-shell'],
] as const

// The Web host has no milestones API; its existing navigation has six entries.
// Runs in the default Chromium CI suite with the project-surface flag disabled.
projectTest(
  'keeps available Web legacy view queries and navigation intact',
  async ({ page, scheduledProject: { path } }) => {
    for (const [view, tabId, contentId] of webViews) {
      const query = `view=${view}`
      await page.goto(`${path}?${query}`)
      await expect(page.getByTestId(contentId)).toBeVisible()
      const select = page.getByTestId('collaboration-project-view-select')
      if (await select.isVisible()) {
        await expect(select).toHaveValue(view)
        await expect(select.locator('option')).toHaveCount(webViews.length)
        for (const [index, [id]] of webViews.entries()) {
          await expect(select.locator('option').nth(index)).toHaveAttribute('value', id)
        }
      } else {
        await expect(page.getByTestId(tabId)).toHaveAttribute('aria-current', 'page')
        const navigation = page.getByTestId(tabId).locator('..')
        await expect(navigation.getByRole('button')).toHaveCount(webViews.length)
        for (const [index, [, id]] of webViews.entries()) {
          await expect(navigation.getByRole('button').nth(index)).toHaveAttribute('data-testid', id)
          await expect(page.getByTestId(id)).toBeVisible()
        }
      }
      await expect(page).toHaveURL(`${path}?${query}`)
    }

    await page.goto(`${path}?surface=plan&mode=timeline`)
    await expect(page.getByTestId('collaboration-board')).toBeVisible()
    await expect(page).toHaveURL(`${path}?surface=plan&mode=timeline`)
  }
)

projectTest(
  'preserves the existing Web fallback for the unavailable milestones view',
  async ({ page, scheduledProject: { path } }) => {
    await page.goto(`${path}?view=milestones`)
    await expect(page.getByTestId('collaboration-board')).toBeVisible()
    await expect(page).toHaveURL(path)
    await expect(page.getByTestId('collaboration-milestones-tab')).toHaveCount(0)
    await expect(
      page.getByTestId('collaboration-project-view-select').locator('option[value="milestones"]')
    ).toHaveCount(0)
  }
)
