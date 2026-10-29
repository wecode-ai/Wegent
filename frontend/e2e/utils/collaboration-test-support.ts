// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from '@playwright/test'
import type { CollaborationView } from '@wegent/collaboration'

export async function dragCollaborationIssue(
  page: Page,
  issueId: string,
  targetColumn: string,
  sourceColumn?: string
) {
  const source = sourceColumn
    ? page.getByTestId(`cloud-todo-column-${sourceColumn}`)
    : page.getByTestId('collaboration-board')
  const card = source.getByTestId(`cloud-todo-card-${issueId}`)
  const target = page.getByTestId(`cloud-todo-column-dropzone-${targetColumn}-content`)
  await expect(card).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  const from = await card.boundingBox()
  expect(from).not.toBeNull()
  await page.mouse.move(from!.x + 20, from!.y + 20)
  await page.mouse.down()
  try {
    await page.mouse.move(from!.x + 30, from!.y + 20, { steps: 3 })
    await expect(page.getByTestId('project-board-drag-overlay')).toBeVisible()
    // Start the drag before scrolling so the source cannot be virtualized away.
    await target.scrollIntoViewIfNeeded()
    const to = await target.boundingBox()
    expect(to).not.toBeNull()
    await page.mouse.move(to!.x + to!.width / 2, to!.y + Math.min(40, to!.height / 2), {
      steps: 10,
    })
    await expect(page.getByTestId(`cloud-todo-column-drag-hint-${targetColumn}`)).toBeVisible()
  } finally {
    await page.mouse.up()
  }
}

export async function dragCollaborationIssueToColumn(
  page: Page,
  issueId: string,
  targetColumn: string,
  sourceColumn?: string
) {
  const mutation = page.waitForResponse(response => {
    const pathname = new URL(response.url()).pathname
    return (
      ['PATCH', 'POST'].includes(response.request().method()) &&
      (pathname.includes(`/loop-items/${encodeURIComponent(issueId)}`) ||
        pathname.endsWith('/loop-items/reorder'))
    )
  })
  await dragCollaborationIssue(page, issueId, targetColumn, sourceColumn)
  const response = await mutation
  if (response.ok()) {
    // The mutation response precedes the persisted-order refresh and card remount.
    await expect(page.getByTestId('board-drop-feedback')).toBeVisible()
    await expect(
      page
        .getByTestId(`cloud-todo-column-${targetColumn}`)
        .getByTestId(`cloud-todo-card-${issueId}`)
    ).toBeVisible()
  }
  return response
}

export async function selectCollaborationProjectView(
  page: Page,
  view: CollaborationView
): Promise<void> {
  const compact = page.getByTestId('collaboration-project-view-select')
  const tab = page.getByTestId(`collaboration-tab-${view}`)
  await expect(compact.or(tab)).toBeVisible()
  if (await compact.isVisible()) {
    await compact.selectOption(view)
  } else {
    await tab.click()
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
