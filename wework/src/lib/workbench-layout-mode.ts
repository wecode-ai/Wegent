export function shouldUseMobileWorkbenchLayout({
  isMobileViewport,
  isTauri,
}: {
  isMobileViewport: boolean
  isTauri: boolean
}): boolean {
  return isMobileViewport && !isTauri
}
