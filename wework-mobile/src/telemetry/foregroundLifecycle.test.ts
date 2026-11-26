import { describe, expect, it } from 'vitest'
import { foregroundTransition } from './foregroundLifecycle'

describe('foreground lifecycle', () => {
  it('ends one foreground session after iOS active to inactive to background', () => {
    const inactive = foregroundTransition(true, 'inactive')
    expect(inactive).toEqual({ foregroundOpen: true, action: null })
    const background = foregroundTransition(inactive.foregroundOpen, 'background')
    expect(background).toEqual({ foregroundOpen: false, action: 'end' })
    expect(foregroundTransition(background.foregroundOpen, 'background').action).toBeNull()
  })

  it('starts a resumed session only after leaving the background', () => {
    expect(foregroundTransition(false, 'active')).toEqual({
      foregroundOpen: true,
      action: 'begin',
    })
    expect(foregroundTransition(true, 'active').action).toBeNull()
  })
})
