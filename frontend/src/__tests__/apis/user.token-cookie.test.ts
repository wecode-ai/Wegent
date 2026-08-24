// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getToken, removeToken } from '@/apis/user'

describe('user token cookie synchronization', () => {
  beforeEach(() => {
    localStorage.clear()
    removeToken()
  })

  afterEach(() => {
    removeToken()
  })

  test('restores a missing cookie from a local storage session', () => {
    const payload = btoa(JSON.stringify({ exp: 4102444800 }))
    const token = `header.${payload}.signature`
    localStorage.setItem('auth_token', token)

    expect(document.cookie).not.toContain('auth_token=')

    expect(getToken()).toBe(token)
    expect(document.cookie).toContain(`auth_token=${encodeURIComponent(token)}`)
  })
})
