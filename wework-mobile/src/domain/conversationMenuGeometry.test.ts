import { describe, expect, it } from 'vitest'
import { conversationMenuFrame } from './conversationMenuGeometry'

const anchor = { x: 271, y: 60, width: 108, height: 44 }
const viewport = { width: 393, height: 852 }
const insets = { top: 60, bottom: 34, left: 0, right: 0 }

describe('conversation menu frame', () => {
  it('expands left and down from the measured capsule top and right edges', () => {
    const frame = conversationMenuFrame(anchor, viewport, insets, 400)
    expect(frame).toEqual({ x: 134, y: 60, width: 245, height: 400 })
    expect(frame.x + frame.width).toBe(anchor.x + anchor.width)
  })
  it('limits tall content to the safe viewport so the menu can scroll', () => {
    expect(conversationMenuFrame(anchor, viewport, insets, 1200)).toEqual({
      x: 134,
      y: 60,
      width: 245,
      height: 750,
    })
  })
  it('moves a low anchor upward only enough to keep all actions reachable', () => {
    expect(conversationMenuFrame({ ...anchor, y: 700 }, viewport, insets, 400).y).toBe(410)
  })
  it('respects landscape cutouts and a short viewport', () => {
    const frame = conversationMenuFrame(
      { x: 730, y: 5, width: 108, height: 44 },
      { width: 844, height: 393 },
      { top: 0, bottom: 21, left: 44, right: 44 },
      400
    )
    expect(frame).toEqual({ x: 547, y: 8, width: 245, height: 356 })
  })
  it('fits a narrow viewport without overflowing either horizontal edge', () => {
    expect(
      conversationMenuFrame(
        { x: 148, y: 60, width: 44, height: 44 },
        { width: 200, height: 852 },
        insets,
        400
      )
    ).toEqual({ x: 8, y: 60, width: 184, height: 400 })
  })
})
