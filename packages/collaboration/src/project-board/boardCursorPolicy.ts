const activePolicies = new WeakMap<Document, Set<object>>()
const visibilityAttributes = ['hidden', 'inert', 'aria-hidden', 'class', 'style']

function updateDocumentPolicy(document: Document, policies: Set<object>): void {
  const body = document.body
  if (policies.size > 0) {
    if (body.dataset.boardCursorPolicy !== 'arrow') body.dataset.boardCursorPolicy = 'arrow'
  } else if (body.dataset.boardCursorPolicy === 'arrow') {
    delete body.dataset.boardCursorPolicy
  }
}

/** React callback ref: only this board's visibility ancestors can change page policy. */
export function registerBoardCursorPolicy(element: HTMLElement | null): (() => void) | undefined {
  if (!element) return
  const document = element.ownerDocument
  const policies = activePolicies.get(document) ?? new Set<object>()
  activePolicies.set(document, policies)
  const owner = {}
  const ancestors: HTMLElement[] = []
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    ancestors.push(node)
    if (node === document.body) break
  }
  const update = () => {
    const hidden = ancestors.some(
      node =>
        node.hasAttribute('hidden') ||
        node.hasAttribute('inert') ||
        node.getAttribute('aria-hidden') === 'true' ||
        node.classList.contains('hidden') ||
        node.style.display === 'none'
    )
    if (element.isConnected && !hidden) policies.add(owner)
    else policies.delete(owner)
    updateDocumentPolicy(document, policies)
  }
  const observer = new MutationObserver(update)
  // Never observe descendants: virtual rows and scrollbar styles are unrelated
  // to whether this page owns the cursor, and change on every scroll frame.
  ancestors.forEach(node =>
    observer.observe(node, { attributes: true, attributeFilter: visibilityAttributes })
  )
  update()
  return () => {
    observer.disconnect()
    policies.delete(owner)
    updateDocumentPolicy(document, policies)
  }
}
