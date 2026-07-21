import { describe, expect, test } from 'vitest'
import { parseDesktopControlKey } from './desktop-control-keyboard'

describe('parseDesktopControlKey', () => {
  test.each([
    ['Meta+Plus', { key: '+', metaKey: true }],
    ['Meta+Minus', { key: '-', metaKey: true }],
    ['Meta+0', { key: '0', metaKey: true }],
    ['Control+Shift+M', { key: 'M', ctrlKey: true, shiftKey: true }],
  ])('parses %s', (value, expected) => {
    expect(parseDesktopControlKey(value)).toMatchObject(expected)
  })
})
