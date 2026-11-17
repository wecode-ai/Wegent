type InertOwnership = { count: number; originalValue: string | null }
const inertOwners = new WeakMap<Element, InertOwnership>()

function isolate(element: Element) {
  const owner = inertOwners.get(element)
  if (owner) {
    owner.count += 1
    return
  }
  const originalValue = element.getAttribute('inert')
  inertOwners.set(element, { count: 1, originalValue })
  if (originalValue === null) element.setAttribute('inert', '')
}

function restore(element: Element) {
  const owner = inertOwners.get(element)
  if (!owner || --owner.count > 0) return
  inertOwners.delete(element)
  if (owner.originalValue === null) element.removeAttribute('inert')
  else element.setAttribute('inert', owner.originalValue)
}

/** Keep ordinary configuration panels outside the modal isolation lifecycle. */
export function isolateModalBackground(dialog: HTMLElement | null, trapFocus = true) {
  if (!trapFocus || !dialog?.matches('[role="dialog"][aria-modal="true"]')) return
  const body = dialog.ownerDocument.body
  if (!body.contains(dialog)) return
  const background: Element[] = []
  for (let branch: Element = dialog; branch !== body && branch.parentElement; ) {
    const parent = branch.parentElement
    for (const sibling of parent.children) {
      if (sibling !== branch) {
        isolate(sibling)
        background.push(sibling)
      }
    }
    branch = parent
  }
  // aria-hidden's shared counter mixes inert with Radix's aria-hidden ownership.
  // Keep native inert independent so either layer can close without leaking attributes.
  let active = true
  return () => {
    if (!active) return
    active = false
    background.forEach(restore)
  }
}
