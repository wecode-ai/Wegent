export function shouldUseMobileWorkbenchLayout({
  isMobileViewport,
  isDesktop,
  surfaceKind,
}: {
  isMobileViewport: boolean
  isDesktop: boolean
  surfaceKind?: 'task' | 'board'
}): boolean {
  return surfaceKind !== 'board' && isMobileViewport && !isDesktop
}
