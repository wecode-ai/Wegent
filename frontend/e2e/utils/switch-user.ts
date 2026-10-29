// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Page } from '@playwright/test'
import type { TestUser } from '../config/test-users'
import { LoginPage } from '../pages/auth/login.page'

export async function switchUser(
  page: Page,
  currentUsername: string,
  nextUser: Pick<TestUser, 'username' | 'password'>
): Promise<void> {
  await page.getByRole('button').filter({ hasText: currentUsername }).click()
  await Promise.all([
    page.waitForURL(url => url.pathname === '/login', { waitUntil: 'domcontentloaded' }),
    page.getByRole('menuitem', { name: /^(退出登录|Logout)$/ }).click(),
  ])
  await page.getByTestId('login-form').waitFor({ state: 'visible' })
  const login = new LoginPage(page)
  await login.fillCredentials(nextUser.username, nextUser.password)
  await login.clickLogin()
  await login.waitForLoginComplete()
}
