/** Measure allocatable memory, including reclaimable file cache. */
export function availableMemoryRatio(
  memory: Pick<Electron.SystemMemoryInfo, 'total' | 'free' | 'available' | 'fileBacked'>,
  platform: NodeJS.Platform
): number {
  if (memory.total <= 0) return 0
  const available =
    platform === 'linux'
      ? memory.available
      : platform === 'darwin'
        ? memory.free + memory.fileBacked
        : memory.free
  return Math.min(1, Math.max(0, available / memory.total))
}
