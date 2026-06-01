export const RESPONSIVE_BREAKPOINTS = {
  mobileMax: 767,
  desktopMin: 768,
} as const

export function isMobileViewport(width: number): boolean {
  return width <= RESPONSIVE_BREAKPOINTS.mobileMax
}

export function isDesktopViewport(width: number): boolean {
  return width >= RESPONSIVE_BREAKPOINTS.desktopMin
}

export function mobileMediaQuery(): string {
  return `(max-width: ${RESPONSIVE_BREAKPOINTS.mobileMax}px)`
}

export function desktopMediaQuery(): string {
  return `(min-width: ${RESPONSIVE_BREAKPOINTS.desktopMin}px)`
}
