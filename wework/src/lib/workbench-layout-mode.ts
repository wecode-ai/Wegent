export function shouldUseMobileWorkbenchLayout({
  isMobileViewport,
  isTauri,
  surfaceKind,
}: {
  isMobileViewport: boolean
  isTauri: boolean
  surfaceKind?: 'task' | 'board'
}): boolean {
  return surfaceKind !== 'board' && isMobileViewport && !isTauri
}
