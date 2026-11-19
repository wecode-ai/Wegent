const MEMORY_FIELDS = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'] as const

type MemoryBytes = Record<(typeof MEMORY_FIELDS)[number], number>
export interface AppWorkerMemory {
  pid: number
  memoryBytes: MemoryBytes
}

export async function readAppWorkerMemory(
  endpoint: URL,
  processSnapshot: unknown
): Promise<AppWorkerMemory> {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`App worker memory request failed: ${response.status}`)
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object') throw new Error('Invalid app worker memory')
  const { pid, memoryBytes } = payload as Partial<AppWorkerMemory>
  const owned = (processSnapshot as { processes?: Array<{ pid: number }> } | null)?.processes
  if (
    typeof pid !== 'number' ||
    pid < 1 ||
    !Number.isSafeInteger(pid) ||
    !Array.isArray(owned) ||
    !owned.some(row => row.pid === pid)
  ) {
    throw new Error('App worker memory belongs to an unregistered process')
  }
  if (!memoryBytes || typeof memoryBytes !== 'object') {
    throw new Error('Invalid app worker memory counters')
  }
  for (const field of MEMORY_FIELDS) {
    const bytes = memoryBytes[field]
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Invalid app worker memory counter: ${field}`)
    }
  }
  return {
    pid,
    memoryBytes: Object.fromEntries(
      MEMORY_FIELDS.map(field => [field, memoryBytes[field]])
    ) as MemoryBytes,
  }
}
