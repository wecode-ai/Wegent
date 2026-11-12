const SAMPLE_LIMIT = 16

/** Describe the actual click target without recording selectors or user content. */
export function desktopControlClickDiagnostics(
  selected: HTMLElement,
  matches: readonly HTMLElement[],
  visible: (element: HTMLElement) => boolean,
  requestedVisible: boolean
) {
  const sample = matches.slice(0, SAMPLE_LIMIT)
  let hiddenAncestor = false
  let ancestor: HTMLElement | null = selected
  while (ancestor) {
    const style = getComputedStyle(ancestor)
    hiddenAncestor ||= style.display === 'none' || style.visibility === 'hidden'
    ancestor = ancestor.parentElement
  }
  const workspace = selected.closest('[data-workspace-tab-content]')
  return {
    requestedVisible,
    selectedVisible: visible(selected),
    selectedConnected: selected.isConnected,
    selectedIndex: sample.indexOf(selected),
    sampledMatchCount: sample.length,
    sampledVisibleCount: sample.filter(visible).length,
    matchesTruncated: matches.length > SAMPLE_LIMIT,
    hiddenAncestor,
    inertAncestor: Boolean(selected.closest('[inert]')),
    workspacePresent: Boolean(workspace),
    workspaceActive: workspace?.getAttribute('aria-hidden') === 'false',
  }
}
