import { afterEach, describe, expect, test, vi } from 'vitest'
import { hasEmbeddedBrowserOverlayConflict } from './embedded-browser-overlay'

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

  test.each([['modal layer', 'z-modal', null]])(
    'detects an intersecting %s',
    (_name, className, role) => {
      const host = document.createElement('div')
      const overlay = document.createElement('div')
      overlay.className = className
      if (role) overlay.setAttribute('role', role)
      if (!className && !role) overlay.dataset.embeddedBrowserOcclusion = ''
      host.getBoundingClientRect = () => rect(400, 100, 500, 500)
      overlay.getBoundingClientRect = () => rect(600, 200, 200, 200)
      document.body.append(host, overlay)

      expect(hasEmbeddedBrowserOverlayConflict(host)).toBe(true)
    }
  )

  test.each([
    ['hidden attribute', (overlay: HTMLElement) => (overlay.hidden = true)],
    ['pointer events disabled', (overlay: HTMLElement) => (overlay.style.pointerEvents = 'none')],
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
})
