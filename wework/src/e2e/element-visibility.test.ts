import { afterEach, describe, expect, it, vi } from 'vitest'
import { readElementVisibility } from './element-visibility'

function bounds(element: HTMLElement, left: number, top: number, width: number, height: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  })
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  })
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('desktop control element visibility', () => {
  it('rejects viewport-visible geometry clipped by an ancestor scrollport', () => {
    const parent = document.createElement('div')
    const target = document.createElement('span')
    parent.style.overflow = 'hidden'
    parent.append(target)
    document.body.append(parent)
    bounds(parent, 0, 100, 300, 0)
    bounds(target, 20, 120, 60, 20)
    expect(readElementVisibility(target)).toEqual({
      visibleIntersection: null,
      hitTestVisible: false,
    })
  })

  it('intersects nested axis-specific scrollports before hit testing', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const target = document.createElement('span')
    outer.style.overflowX = 'auto'
    inner.style.overflowY = 'scroll'
    outer.append(inner)
    inner.append(target)
    document.body.append(outer)
    bounds(outer, 40, 0, 100, 500)
    bounds(inner, 0, 100, 300, 50)
    bounds(target, 20, 80, 200, 100)
    const hit = vi.fn(() => target)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit })
    expect(readElementVisibility(target)).toEqual({
      visibleIntersection: { left: 40, top: 100, right: 140, bottom: 150, width: 100, height: 50 },
      hitTestVisible: true,
    })
    expect(hit).toHaveBeenCalledWith(90, 125)
  })

  it('rejects an overlay and accepts a real descendant hit', () => {
    const target = document.createElement('button')
    const child = document.createElement('span')
    target.append(child)
    document.body.append(target)
    bounds(target, 20, 20, 100, 44)
    const hit = vi.fn((): Element => document.body)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit })
    expect(readElementVisibility(target).hitTestVisible).toBe(false)
    hit.mockReturnValue(child)
    expect(readElementVisibility(target).hitTestVisible).toBe(true)
  })
})
