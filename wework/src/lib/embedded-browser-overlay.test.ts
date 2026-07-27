import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  embeddedBrowserOverlayMutationAffectsVisibility,
  hasEmbeddedBrowserOverlayConflict,
} from './embedded-browser-overlay'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

describe('embedded browser overlay detection', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  test.each([
    ['modal layer', 'z-modal', null],
    ['popover layer', 'z-system-popover', null],
    ['semantic menu', '', 'menu'],
    ['explicit overlay', '', null],
  ])('detects an intersecting %s', (_name, className, role) => {
    const host = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.className = className
    if (role) overlay.setAttribute('role', role)
    if (!className && !role) overlay.dataset.embeddedBrowserOcclusion = ''
    host.getBoundingClientRect = () => rect(400, 100, 500, 500)
    overlay.getBoundingClientRect = () => rect(600, 200, 200, 200)
    document.body.append(host, overlay)

    expect(hasEmbeddedBrowserOverlayConflict(host)).toBe(true)
  })

  test('ignores overlays outside the browser bounds', () => {
    const host = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    host.getBoundingClientRect = () => rect(400, 100, 500, 500)
    overlay.getBoundingClientRect = () => rect(20, 20, 200, 60)
    document.body.append(host, overlay)

    expect(hasEmbeddedBrowserOverlayConflict(host)).toBe(false)
  })

  test.each([
    ['hidden attribute', (overlay: HTMLElement) => (overlay.hidden = true)],
    ['aria hidden', (overlay: HTMLElement) => overlay.setAttribute('aria-hidden', 'true')],
    ['pointer events disabled', (overlay: HTMLElement) => (overlay.style.pointerEvents = 'none')],
    ['transparent', (overlay: HTMLElement) => (overlay.style.opacity = '0')],
  ])('ignores an intersecting menu with %s', (_name, hideOverlay) => {
    const host = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'menu')
    hideOverlay(overlay)
    host.getBoundingClientRect = () => rect(400, 100, 500, 500)
    overlay.getBoundingClientRect = () => rect(600, 200, 200, 200)
    document.body.append(host, overlay)

    expect(hasEmbeddedBrowserOverlayConflict(host)).toBe(false)
  })

  test('ignores unrelated DOM mutations and reacts to overlay mutations', async () => {
    const unrelated = document.createElement('div')
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'menu')
    const affectedResults: boolean[] = []
    const observer = new MutationObserver(mutations => {
      affectedResults.push(embeddedBrowserOverlayMutationAffectsVisibility(mutations))
    })
    observer.observe(document.body, { childList: true })

    document.body.append(unrelated)
    await Promise.resolve()
    document.body.append(overlay)
    await Promise.resolve()
    observer.disconnect()

    expect(affectedResults).toEqual([false, true])
  })
})
