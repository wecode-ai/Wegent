import { describe, expect, it } from 'vitest'

import { modelControlAppearance, reduceModelControlLayer } from './modelControlPresentation'

describe('reduceModelControlLayer', () => {
  it('opens the inline quick selector', () => {
    expect(reduceModelControlLayer('composer', 'openQuick')).toBe('quick')
  })

  it('closes the inline quick selector', () => {
    expect(reduceModelControlLayer('quick', 'close')).toBe('composer')
  })
})

describe('modelControlAppearance', () => {
  it('uses a light glass palette in light mode', () => {
    expect(modelControlAppearance(false)).toEqual({
      backdropColor: 'rgba(0,0,0,0.18)',
      colorScheme: 'light',
      groupBackgroundColor: 'rgba(248,248,248,0.72)',
      groupTintColor: '#eeeeee',
      menuBackgroundColor: 'rgba(248,248,248,0.86)',
      menuTintColor: '#f4f4f4',
    })
  })

  it('uses a dark glass palette in dark mode', () => {
    expect(modelControlAppearance(true).colorScheme).toBe('dark')
    expect(modelControlAppearance(true).groupTintColor).toBe('#303030')
    expect(modelControlAppearance(true).menuTintColor).toBe('#252525')
  })
})
