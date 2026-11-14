export function revealWorkspaceTab(viewport: HTMLElement | null) {
  const tab = viewport?.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!viewport || !tab) return
  const viewportRect = viewport.getBoundingClientRect()
  const tabRect = tab.getBoundingClientRect()
  if (tabRect.left < viewportRect.left) viewport.scrollLeft += tabRect.left - viewportRect.left
  else if (tabRect.right > viewportRect.right)
    viewport.scrollLeft += tabRect.right - viewportRect.right
}
