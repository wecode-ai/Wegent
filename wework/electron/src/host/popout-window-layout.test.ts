import { describe, expect, test } from 'vitest'
import { popoutWindowBounds } from './popout-window-layout.js'

const workArea = { x: 0, y: 0, width: 1440, height: 900 }

describe('popoutWindowBounds', () => {
  test('keeps the composer fixed while a menu opens and closes above it', () => {
    const compact = { x: 485, y: 394, width: 470, height: 112 }

    const menu = popoutWindowBounds(compact, workArea, 'composer', 'menu')
    expect(menu).toEqual({ x: 485, y: 86, width: 470, height: 420 })
    expect(popoutWindowBounds(menu, workArea, 'menu', 'composer')).toEqual(compact)
  })

  test('centers the conversation and keeps it inside the display work area', () => {
    const compact = { x: 920, y: 610, width: 470, height: 112 }

    const conversation = popoutWindowBounds(compact, workArea, 'composer', 'conversation')
    expect(conversation).toEqual({ x: 680, y: 260, width: 760, height: 640 })
  })
})
