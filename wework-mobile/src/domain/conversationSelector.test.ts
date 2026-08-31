import { describe, expect, it } from 'vitest'

import { conversationSelectorVisible } from './conversationSelector'

describe('conversationSelectorVisible', () => {
  it('keeps the permission selector available throughout an existing conversation', () => {
    expect(conversationSelectorVisible('permission', false)).toBe(true)
  })

  it('keeps new-conversation configuration selectors on the new screen', () => {
    expect(conversationSelectorVisible('device', true)).toBe(true)
    expect(conversationSelectorVisible('device', false)).toBe(false)
    expect(conversationSelectorVisible('project', false)).toBe(false)
  })

  it('does not open a sheet without a selector or for the inline branch state', () => {
    expect(conversationSelectorVisible(null, true)).toBe(false)
    expect(conversationSelectorVisible('branch', true)).toBe(false)
  })
})
