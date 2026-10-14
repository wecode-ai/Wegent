export function createFileOperationQueue(limit = 8) {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    else active += 1
    try {
      return await operation()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
}
