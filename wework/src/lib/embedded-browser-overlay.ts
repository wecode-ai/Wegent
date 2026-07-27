const EMBEDDED_BROWSER_OVERLAY_SELECTOR = [
  '[data-embedded-browser-occlusion]',
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '.z-modal',
  '.z-system-modal',
  '.z-system-popover',
].join(',')

function containsOverlayCandidate(node: Node): boolean {
  if (!(node instanceof Element)) return false
  return (
    node.matches(EMBEDDED_BROWSER_OVERLAY_SELECTOR) ||
    Boolean(node.querySelector(EMBEDDED_BROWSER_OVERLAY_SELECTOR))
  )
}

function hasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0
}

function rectsIntersect(first: DOMRect, second: DOMRect): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  )
}

function isVisibleOverlay(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false

  const style = window.getComputedStyle(element)
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    style.pointerEvents === 'none'
  ) {
    return false
  }

  return hasArea(element.getBoundingClientRect())
}

export function hasEmbeddedBrowserOverlayConflict(
  browserHost: HTMLElement,
  root: ParentNode = document
): boolean {
  const browserRect = browserHost.getBoundingClientRect()
  if (!hasArea(browserRect)) return false

  return Array.from(root.querySelectorAll<HTMLElement>(EMBEDDED_BROWSER_OVERLAY_SELECTOR)).some(
    overlay =>
      overlay !== browserHost &&
      !browserHost.contains(overlay) &&
      isVisibleOverlay(overlay) &&
      rectsIntersect(browserRect, overlay.getBoundingClientRect())
  )
}

export function embeddedBrowserOverlayMutationAffectsVisibility(
  mutations: MutationRecord[]
): boolean {
  return mutations.some(mutation => {
    if (containsOverlayCandidate(mutation.target)) return true
    return (
      Array.from(mutation.addedNodes).some(containsOverlayCandidate) ||
      Array.from(mutation.removedNodes).some(containsOverlayCandidate)
    )
  })
}
