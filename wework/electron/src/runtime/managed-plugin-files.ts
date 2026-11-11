import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

const WINDOWS_COPY_CONCURRENCY = 16

export async function copyManagedPlugin(
  source: string,
  destination: string,
  options: { platform?: NodeJS.Platform } = {}
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    await cp(source, destination, { recursive: true })
    return
  }
  await copyWindowsEntry(source, destination, createLimiter(WINDOWS_COPY_CONCURRENCY))
}

type LimitedRunner = <Result>(task: () => Promise<Result>) => Promise<Result>

function createLimiter(limit: number): LimitedRunner {
  let active = 0
  const waiting: Array<() => void> = []
  return async task => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve))
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

async function copyWindowsEntry(
  source: string,
  destination: string,
  run: LimitedRunner
): Promise<void> {
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink()) {
    // pnpm's Windows package cleanup traverses junctions. Managed packages
    // must own their files so cleanup cannot delete shared component assets.
    await copyWindowsEntry(await realpath(source), destination, run)
    return
  }
  if (!metadata.isDirectory()) {
    await run(() => cp(source, destination))
    return
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const entries = await readdir(source)
  // Windows profile preparation copies thousands of small files. Bounded
  // parallelism keeps it fast without exhausting handles.
  await Promise.all(
    entries.map(entry => copyWindowsEntry(join(source, entry), join(destination, entry), run))
  )
}
