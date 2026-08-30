import { describe, expect, it } from 'vitest'

import { reduceModelControlLayer } from './modelControlPresentation'

describe('reduceModelControlLayer', () => {
  it('opens the inline quick selector', () => {
    expect(reduceModelControlLayer('composer', 'openQuick')).toBe('quick')
  })

  it('closes the inline quick selector', () => {
    expect(reduceModelControlLayer('quick', 'close')).toBe('composer')
  })
})
