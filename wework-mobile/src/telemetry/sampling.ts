export function telemetrySampleBucket(installationId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < installationId.length; index += 1) {
    hash ^= installationId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}
