export function shouldUseMobileWorkbenchLayout({
  isMobileViewport,
  isDesktop,
}: {
  isMobileViewport: boolean
  isDesktop: boolean
}): boolean {
  return isMobileViewport && !isDesktop
}
