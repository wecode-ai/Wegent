// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Page } from '@playwright/test'
import { waitFor } from '@testing-library/react'
import { switchUser } from '../../../e2e/utils/switch-user'

jest.mock('@playwright/test', () => ({ expect: jest.fn() }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function switchPage(options: { holdNavigation?: boolean; holdForm?: boolean } = {}) {
  const events: string[] = []
  const logoutNavigation = deferred()
  const loginFormReady = deferred()
  let onLoginPage = false
  let formReady = false
  let submitted = false
  const assertFormReady = () => {
    if (!onLoginPage || !formReady) throw new Error('Login form is not ready')
  }
  const input = (name: string) => ({
    first() {
      return this
    },
    clear: jest.fn(async () => {
      assertFormReady()
      events.push(`clear-${name}`)
    }),
    fill: jest.fn(async (value: string) => {
      assertFormReady()
      events.push(`fill-${name}:${value}`)
    }),
  })
  const username = input('username')
  const password = input('password')
  const submit = {
    click: jest.fn(async () => {
      assertFormReady()
      submitted = true
      events.push('submit')
    }),
  }
  const openMenu = {
    filter: jest.fn().mockReturnThis(),
    click: jest.fn(async () => {
      events.push('open-menu')
    }),
  }
  const logout = {
    click: jest.fn(async () => {
      events.push('logout')
      if (!options.holdNavigation) logoutNavigation.resolve()
    }),
  }
  const loginForm = {
    waitFor: jest.fn(async () => {
      if (!onLoginPage) throw new Error('Logout navigation has not finished')
      events.push('wait-login-form')
      if (options.holdForm) await loginFormReady.promise
      formReady = true
    }),
  }
  const page = {
    getByRole: jest.fn((role: string) => (role === 'button' ? openMenu : logout)),
    goto: jest.fn(async () => {
      throw new Error('Navigation to /login is interrupted by /login?redirect=%2Fcollaboration')
    }),
    waitForURL: jest.fn(async (matches: (url: URL) => boolean) => {
      if (matches(new URL('http://localhost/login?redirect=%2Fcollaboration'))) {
        events.push('wait-logout-navigation')
        await logoutNavigation.promise
        onLoginPage = true
      } else {
        if (!submitted || !matches(new URL('http://localhost/collaboration')))
          throw new Error('Login was not submitted')
        events.push('wait-login-complete')
      }
    }),
    getByTestId: jest.fn(() => loginForm),
    locator: jest.fn((selector: string) => {
      if (selector.includes('user_name')) return username
      if (selector.includes('password')) return password
      if (selector === 'button[type="submit"]') return submit
      return {}
    }),
  }
  return {
    page,
    events,
    openMenu,
    logout,
    username,
    password,
    loginForm,
    logoutNavigation,
    loginFormReady,
  }
}

test('switches accounts on the logout redirect without starting a competing navigation', async () => {
  const { page, events, openMenu } = switchPage()

  await expect(
    switchUser(page as unknown as Page, 'first-user', {
      username: 'second-user',
      password: 'test-password',
    })
  ).resolves.toBeUndefined()

  expect(openMenu.filter).toHaveBeenCalledWith({ hasText: 'first-user' })
  expect(page.goto).not.toHaveBeenCalled()
  expect(page.getByTestId).toHaveBeenCalledWith('login-form')
  expect(events).toEqual([
    'open-menu',
    'wait-logout-navigation',
    'logout',
    'wait-login-form',
    'clear-username',
    'fill-username:second-user',
    'clear-password',
    'fill-password:test-password',
    'submit',
    'wait-login-complete',
  ])
})

test('waits for both the logout navigation and the login form before entering credentials', async () => {
  const { page, logout, username, loginForm, logoutNavigation, loginFormReady } = switchPage({
    holdNavigation: true,
    holdForm: true,
  })
  const switching = switchUser(page as unknown as Page, 'first-user', {
    username: 'second-user',
    password: 'test-password',
  })
  await waitFor(() => expect(logout.click).toHaveBeenCalled())
  expect(loginForm.waitFor).not.toHaveBeenCalled()
  expect(username.clear).not.toHaveBeenCalled()

  logoutNavigation.resolve()
  await waitFor(() => expect(loginForm.waitFor).toHaveBeenCalledWith({ state: 'visible' }))
  expect(username.clear).not.toHaveBeenCalled()

  loginFormReady.resolve()
  await expect(switching).resolves.toBeUndefined()
  expect(username.fill).toHaveBeenCalledWith('second-user')
  expect(page.goto).not.toHaveBeenCalled()
})

test('reports a failed logout navigation without submitting another account', async () => {
  const { page, username } = switchPage()
  page.waitForURL.mockRejectedValueOnce(new Error('Logout navigation failed'))

  await expect(
    switchUser(page as unknown as Page, 'first-user', {
      username: 'second-user',
      password: 'test-password',
    })
  ).rejects.toThrow('Logout navigation failed')

  expect(username.clear).not.toHaveBeenCalled()
  expect(page.goto).not.toHaveBeenCalled()
})
