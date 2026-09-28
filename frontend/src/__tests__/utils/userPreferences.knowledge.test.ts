// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { getShowAdvancedKnowledge, saveShowAdvancedKnowledge } from '@/utils/userPreferences'

describe('knowledge advanced visibility preference', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to hidden', () => {
    expect(getShowAdvancedKnowledge()).toBe(false)
  })

  it('persists in browser storage without account state', () => {
    saveShowAdvancedKnowledge(true)

    expect(localStorage.getItem('wegent_show_advanced_knowledge')).toBe('true')
    expect(getShowAdvancedKnowledge()).toBe(true)
  })
})
