// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { REGULAR_USER } from '../../config/test-users'
import { addProjectMember, createProjectFixture } from '../../utils/issue-dispatch-test-support'

async function captureEvidence(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, fullPage: true })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test.describe('Issue Dispatch human assignment', () => {
  test('assigns the Issue to a project member without auto-completing it', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000)
    const suffix = `${Date.now()}`
    const fixture = await createProjectFixture(page, suffix, `Human dispatch ${suffix}`)
    const memberId = await addProjectMember(page, REGULAR_USER.username)
    await page.goto(`${fixture.projectPath}/issues/${encodeURIComponent(fixture.issueId)}`)
    await captureEvidence(page, testInfo, '01-issue-before-dispatch')

    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId(`cloud-todo-detail-assignee-option-user:${memberId}`).click()
    await page.getByTestId('cloud-todo-save').click()
    await expect(page.getByTestId('cloud-todo-save')).toHaveCount(0)
    await expect(page.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
      'data-value',
      `user:${memberId}`
    )
    await expect(page.getByTestId('cloud-todo-detail-status')).toHaveValue('inbox')
    await captureEvidence(page, testInfo, '02-human-assignment-recorded')
  })
})
