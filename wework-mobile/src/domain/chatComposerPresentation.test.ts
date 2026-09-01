import { describe, expect, it } from 'vitest'

import { chatComposerPresentation } from './chatComposerPresentation'

describe('chatComposerPresentation', () => {
  it('uses a single compact row while the input is not focused', () => {
    expect(chatComposerPresentation(false)).toBe('compact')
  })

  it('expands the composer while the input is focused', () => {
    expect(chatComposerPresentation(true)).toBe('expanded')
  })

  it('stays expanded while attachments or a goal draft are visible', () => {
    expect(chatComposerPresentation(false, true)).toBe('expanded')
  })
})
