// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from '@playwright/test'

export async function selectCollaborationProjectView(
  page: Page,
  view: 'board' | 'manage'
): Promise<void> {
  const compact = page.getByTestId('collaboration-project-view-select')
  if (await compact.isVisible()) {
    await compact.selectOption(view)
  } else {
    await page.getByTestId(`collaboration-tab-${view}`).click()
  }
}

export async function openBlankProjectCreation(page: Page): Promise<void> {
  const testId = 'collaboration-workspace-project-create'
  const trigger = page.getByTestId(testId)
  await expect(trigger).toBeVisible()
  await expect(page.locator(`[data-testid="${testId}"][aria-haspopup]`)).toHaveCount(0)
  await trigger.click()
  await expect(page.getByTestId('collaboration-project-create-dialog')).toBeVisible()
  await expect(page.getByTestId(`${testId}-menu`)).toHaveCount(0)
}

/**
 * The Issue comment boxes are the shared ProseMirror composer, which refuses
 * input while its host still loads. `fill` reports a non-editable editor
 * instead of waiting for it, so wait for the editor to accept input first.
 */
export async function writeSharedComposer(locator: Locator, text: string): Promise<void> {
  await expect
    .poll(() => locator.evaluate((element: HTMLElement) => element.isContentEditable), {
      message: 'The shared composer never became editable',
    })
    .toBe(true)
  await locator.fill(text)
}

export async function webApi<T>(
  page: Page,
  path: string,
  init: { body?: unknown; method?: string } = {}
): Promise<T> {
  return page.evaluate(
    async ({ requestPath, requestInit }) => {
      const response = await fetch(requestPath, {
        method: requestInit.method ?? 'GET',
        cache: 'no-store',
        headers:
          requestInit.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: requestInit.body === undefined ? undefined : JSON.stringify(requestInit.body),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`${requestInit.method ?? 'GET'} ${requestPath}: ${response.status} ${text}`)
      }
      return text ? JSON.parse(text) : null
    },
    { requestPath: path, requestInit: init }
  )
}
