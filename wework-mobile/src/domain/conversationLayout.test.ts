import { describe, expect, it } from 'vitest'

import { composerBottomSpacing } from './conversationLayout'

describe('composerBottomSpacing', () => {
  it('uses the device safe area while the keyboard is closed', () => {
    expect(composerBottomSpacing(34, false)).toBe(34)
  })

  it('uses only the visual gap above the keyboard', () => {
    expect(composerBottomSpacing(34, true)).toBe(8)
  })

  it('keeps a minimum visual gap on devices without a bottom inset', () => {
    expect(composerBottomSpacing(0, false)).toBe(8)
  })
})
