import { afterEach, describe, expect, it, vi } from 'vitest'
import { readElementVisibility, readSelectionVisibility } from './element-visibility'

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
  it('measures only the requested editor caret and preserves its selection', () => {
    const viewport = document.createElement('div')
    const editor = document.createElement('div')
    editor.textContent = 'draft'
    viewport.style.overflow = 'auto'
    viewport.append(editor)
    document.body.append(viewport)
    bounds(viewport, 0, 20, 300, 100)
    const selection = document.getSelection()!
    selection.setPosition(editor.firstChild, 5)
    let top = 80
    const createRange = document.createRange.bind(document)
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange()
      Object.defineProperty(range, 'getBoundingClientRect', {
        value: () => ({ left: 20, top, width: 0, height: 20, bottom: top + 20 }),
      })
      return range
    })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => editor })
    expect(readSelectionVisibility(editor)?.hitTestVisible).toBe(true)
    top = 200
    expect(readSelectionVisibility(editor)?.visibleIntersection).toBeNull()
    expect(readSelectionVisibility(document.createElement('div'))).toBeNull()
    expect(selection.focusNode).toBe(editor.firstChild)
    expect(selection.focusOffset).toBe(5)
  })
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

  it('clips an action inside its top-layer menu without clipping it to the dialog', () => {
    const dialog = document.createElement('div')
    const menu = document.createElement('div')
    const action = document.createElement('button')
    dialog.style.overflow = 'hidden'
    menu.style.overflow = 'auto'
    menu.setAttribute('popover', 'manual')
    menu.showPopover = vi.fn()
    vi.spyOn(menu, 'matches').mockImplementation(selector => selector === ':popover-open')
    menu.append(action)
    dialog.append(menu)
    document.body.append(dialog)
    bounds(dialog, 17, 20, 356, 200)
    bounds(menu, 8, 30, 176, 48)
    bounds(action, 13, 34, 166, 48)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => action,
    })
    expect(readElementVisibility(action)).toEqual({
      visibleIntersection: { left: 13, top: 34, right: 179, bottom: 78, width: 166, height: 44 },
      hitTestVisible: true,
    })
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
