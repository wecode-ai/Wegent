import { expect } from '@playwright/test'
import { projectTest } from '../../utils/collaboration-project-fixture'

// Runs in the default Chromium CI suite with the dark-launch flag disabled.
projectTest(
  'keeps all seven legacy view queries and navigation intact',
  async ({ page, scheduledProject: { path } }) => {
    const views = [
      ['board', 'collaboration-tab-board', 'collaboration-board'],
      ['calendar', 'collaboration-calendar-tab', 'collaboration-calendar'],
      ['gantt', 'collaboration-gantt-tab', 'collaboration-gantt'],
      ['table', 'collaboration-tab-table', 'collaboration-issue-table-search'],
      ['milestones', 'collaboration-milestones-tab', 'milestones-page'],
      ['files', 'collaboration-tab-files', 'cloud-files-view'],
      ['manage', 'collaboration-tab-manage', 'project-settings-shell'],
    ] as const

    for (const [view, tabId, contentId] of views) {
      const query = `view=${view}`
      await page.goto(`${path}?${query}`)
      await expect(page.getByTestId(contentId)).toBeVisible()
      const select = page.getByTestId('collaboration-project-view-select')
      if (await select.isVisible()) {
        await expect(select).toHaveValue(view)
        await expect(select.locator('option')).toHaveCount(7)
      } else {
        await expect(page.getByTestId(tabId)).toHaveAttribute('aria-current', 'page')
        for (const [, id] of views) await expect(page.getByTestId(id)).toBeVisible()
      }
      await expect(page).toHaveURL(`${path}?${query}`)
    }

    await page.goto(`${path}?surface=plan&mode=timeline`)
    await expect(page.getByTestId('collaboration-board')).toBeVisible()
    await expect(page).toHaveURL(`${path}?surface=plan&mode=timeline`)
  }
)
