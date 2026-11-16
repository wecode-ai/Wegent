// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'

test('workspace creation survives authenticated account initialization', async ({ page }) => {
  let releaseIdentity!: () => void
  let identityRequested = false
  const release = new Promise<void>(resolve => {
    releaseIdentity = resolve
  })
  await page.route('**/api/users/me', async route => {
    identityRequested = true
    await release
    await route.continue()
  })
  try {
    await page.goto('/collaboration', { waitUntil: 'domcontentloaded' })
    await expect.poll(() => identityRequested).toBe(true)
    // Observe the held real request across frames; an anonymous workbench must
    // never become interactive before its authenticated owner is known.
    const stayedLoading = await page.evaluate(
      () =>
        new Promise<boolean>(resolve => {
          const startedAt = performance.now()
          const sample = () => {
            if (document.querySelector('[data-testid="collaboration-platform-root"]')) {
              resolve(false)
              return
            }
            if (performance.now() - startedAt >= 250) {
              resolve(true)
              return
            }
            requestAnimationFrame(sample)
          }
          sample()
        })
    )
    expect(stayedLoading).toBe(true)
    await expect(page.getByTestId('collaboration-back-to-workbench')).toBeVisible()
    releaseIdentity()
    await expect(page.getByTestId('collaboration-platform-root')).toBeVisible()
    await page.getByTestId('collaboration-workspace-create').click()
    const name = page.getByTestId('collaboration-workspace-name-input')
    await name.fill('Account initialization regression')
    await expect(name).toHaveValue('Account initialization regression')
    await page.getByTestId('collaboration-workspace-create-cancel').click()
    await expect(name).toHaveCount(0)
  } finally {
    releaseIdentity()
  }
})
