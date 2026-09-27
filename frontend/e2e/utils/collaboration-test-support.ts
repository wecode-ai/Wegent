// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, type Locator, type Page } from '@playwright/test'

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
