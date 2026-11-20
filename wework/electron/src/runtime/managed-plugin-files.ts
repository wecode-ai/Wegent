import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

const WINDOWS_COPY_CONCURRENCY = 8

export async function copyManagedPlugin(
  source: string,
  destination: string,
  options: { platform?: NodeJS.Platform; concurrency?: number } = {}
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    await cp(source, destination, { recursive: true })
    return
  }
  const concurrency = options.concurrency ?? WINDOWS_COPY_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Windows copy concurrency must be a positive integer')
  const limited = createOperationLimiter(concurrency)
  await copyWindowsEntry(source, destination, limited)
}

type LimitedOperation = <T>(operation: () => Promise<T>) => Promise<T>

async function copyWindowsEntry(
  source: string,
  destination: string,
  limited: LimitedOperation
): Promise<void> {
  const metadata = await limited(() => lstat(source))
  if (metadata.isSymbolicLink()) {
    // pnpm's Windows package cleanup traverses junctions. Managed packages
    // must own their files so cleanup cannot delete shared component assets.
    await copyWindowsEntry(await limited(() => realpath(source)), destination, limited)
    return
  }
  if (!metadata.isDirectory()) {
    await limited(() => cp(source, destination))
    return
  }
  await limited(() => mkdir(destination, { recursive: true, mode: 0o700 }))
  const entries = await limited(() => readdir(source))
  const children = entries.map(entry =>
    copyWindowsEntry(join(source, entry), join(destination, entry), limited)
  )
  const results = await Promise.allSettled(children)
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

function createOperationLimiter(limit: number): LimitedOperation {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active === limit) await new Promise<void>(resolve => waiting.push(resolve))
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
