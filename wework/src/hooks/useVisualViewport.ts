import { useEffect } from 'react'

const HEIGHT_VAR = '--visual-viewport-height'

/**
 * Tracks the visual viewport (the area not covered by the on-screen keyboard)
 * and exposes its height as a CSS custom property on the document root:
 *
 *   --visual-viewport-height  current visible height in px
 *
 * iOS Safari / WKWebView overlay the keyboard instead of shrinking the layout
 * viewport, so `100dvh` stays full-height and the browser scrolls the document
 * up to reveal a focused input that sits below the fold — pushing fixed chrome
 * off the top.
 *
 * The fix:
 *  1. Pin <body> with position:fixed + inset:0 so iOS cannot scroll the layout
 *     viewport on focus. inset:0 (not just top/width) keeps the body filling the
 *     viewport — pinning with only top/width collapses its height and breaks
 *     fixed overlays such as the mobile drawer (white screen).
 *  2. Expose the visible height so chrome containers shrink to fit and keep the
 *     focused input above the keyboard.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const body = document.body
    const root = document.documentElement
    const previous = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      bottom: body.style.bottom,
      width: body.style.width,
      height: body.style.height,
      overflow: body.style.overflow,
      rootOverflow: root.style.overflow,
    }

    body.style.position = 'fixed'
    body.style.top = '0'
    body.style.left = '0'
    body.style.right = '0'
    body.style.bottom = '0'
    body.style.width = '100%'
    body.style.height = '100%'
    body.style.overflow = 'hidden'
    root.style.overflow = 'hidden'

    const restoreBase = () => {
      root.style.removeProperty(HEIGHT_VAR)
      body.style.position = previous.position
      body.style.top = previous.top
      body.style.left = previous.left
      body.style.right = previous.right
      body.style.bottom = previous.bottom
      body.style.width = previous.width
      body.style.height = previous.height
      body.style.overflow = previous.overflow
      root.style.overflow = previous.rootOverflow
    }

    const viewport = window.visualViewport
    if (!viewport) {
      root.style.setProperty(HEIGHT_VAR, '100dvh')
      return restoreBase
    }

    let frame = 0
    const apply = () => {
      frame = 0
      root.style.setProperty(HEIGHT_VAR, `${viewport.height}px`)
    }
    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      restoreBase()
    }
  }, [])
}
