/** Measure allocatable memory, including reclaimable file cache. */
export function availableMemoryRatio(
  memory: Pick<Electron.SystemMemoryInfo, 'total' | 'free' | 'fileBacked'>,
  platform: NodeJS.Platform,
  availableMemoryBytes: number
): number {
  if (memory.total <= 0) return 0
  const available =
    platform === 'linux'
      ? availableMemoryBytes / 1024
      : platform === 'darwin'
        ? memory.free + memory.fileBacked
        : memory.free
  return Math.min(1, Math.max(0, available / memory.total))
}
