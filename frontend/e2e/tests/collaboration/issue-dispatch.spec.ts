// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import {
  addProjectMember,
  createProjectFixture,
  dispatchToFirstTarget,
} from '../../utils/issue-dispatch-test-support'

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test.describe('Issue Dispatch human assignment', () => {
  test('records the concrete child task and recipient without auto-completing the Issue', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const taskTitle = `Verify human delivery ${suffix}`
    const fixture = await createProjectFixture(page, suffix, `Human dispatch ${suffix}`)
    await addProjectMember(page, REGULAR_USER.username)
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    await captureEvidence(page, testInfo, '01-issue-before-dispatch')
    await dispatchToFirstTarget(page, 'human', taskTitle, REGULAR_USER.username)

    const assignment = page
      .locator('[data-testid^="issue-dispatch-event-assigned-"]')
      .filter({ hasText: taskTitle })
    await expect(assignment).toContainText(REGULAR_USER.username)
    await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('in_progress')
    await captureEvidence(page, testInfo, '02-human-assignment-recorded')
  })
})
