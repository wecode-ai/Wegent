import { describe, expect, it } from 'vitest'
import { modelPopoverLayout } from './modelPopoverLayout'

describe('model popover bounds', () => {
  it('right-aligns a measured menu above its row within safe areas', () => {
    expect(
      modelPopoverLayout(
        { x: 24, y: 480, width: 342, height: 50 },
        { width: 390, height: 844, topInset: 59, bottomInset: 34 },
        280
      )
    ).toEqual({ left: 102, top: 250, width: 264, height: 280 })
  })

  it('bounds a long catalog on a small landscape viewport', () => {
    const frame = modelPopoverLayout(
      { x: 260, y: 160, width: 300, height: 50 },
      { width: 568, height: 320, topInset: 0, bottomInset: 21 },
      900
    )
    expect(frame).toEqual({ left: 288, top: 16, width: 264, height: 267 })
  })

  it('keeps oversized content and off-edge anchors inside a narrow screen', () => {
    const frame = modelPopoverLayout(
      { x: -20, y: 20, width: 240, height: 50 },
      { width: 250, height: 500, topInset: 24, bottomInset: 16 },
      800
    )
    expect(frame).toEqual({ left: 16, top: 40, width: 218, height: 428 })
  })
})
