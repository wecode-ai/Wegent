export function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  createTimeoutError: (timeoutMs: number) => unknown
): Promise<T> {
  if (timeoutMs == null) return promise

  let timeoutId: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(createTimeoutError(timeoutMs)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId != null) window.clearTimeout(timeoutId)
  })
}
