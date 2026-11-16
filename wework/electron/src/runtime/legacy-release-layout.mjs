// Delivered clients that select releases before main migrates userData.
const affected = new Set(['0.5.13-beta.8', '0.6.2', '0.6.3', '0.6.4-beta.1'])

export function usesLegacyReleaseLayout(version) {
  return affected.has(version)
}
