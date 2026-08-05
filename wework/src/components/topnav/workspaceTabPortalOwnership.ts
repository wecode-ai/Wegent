let activeWorkspaceTabPortalOwner: string | null = null

export function getActiveWorkspaceTabPortalOwner() {
  return activeWorkspaceTabPortalOwner
}

export function syncWorkspaceTabPortalOwnerElement(element: HTMLElement, ownerId: string) {
  const active = ownerId === activeWorkspaceTabPortalOwner
  element.hidden = !active
  element.style.display = active ? 'contents' : 'none'
}

export function setActiveWorkspaceTabPortalOwner(ownerId: string | null) {
  activeWorkspaceTabPortalOwner = ownerId
  // Hidden React Activities defer child updates, while their portals remain attached to
  // global titlebar targets. Update the portal wrappers from the active tab boundary.
  document.querySelectorAll<HTMLElement>('[data-workspace-tab-portal-owner]').forEach(element => {
    const elementOwnerId = element.dataset.workspaceTabPortalOwner
    if (elementOwnerId) syncWorkspaceTabPortalOwnerElement(element, elementOwnerId)
  })
}
