export type DesktopPlatform = 'mac' | 'win' | 'linux'

export function getPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') return 'mac'

  const userAgent = navigator.userAgent || ''
  if (/Mac/i.test(userAgent)) return 'mac'
  if (/Win/i.test(userAgent)) return 'win'
  return 'linux'
}
