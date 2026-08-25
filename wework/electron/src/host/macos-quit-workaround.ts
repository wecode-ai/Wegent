export function requiresMacosQuitWorkaround(
  platform: NodeJS.Platform,
  kernelRelease: string
): boolean {
  if (platform !== 'darwin') return false
  const [majorText, minorText] = kernelRelease.split('.')
  const major = Number(majorText)
  const minor = Number(minorText)
  return major === 25 && Number.isInteger(minor) && minor < 5
}
