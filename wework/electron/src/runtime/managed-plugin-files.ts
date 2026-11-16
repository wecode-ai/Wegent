import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

const WINDOWS_COPY_CONCURRENCY = 16

export async function copyManagedPlugin(
  source: string,
  destination: string,
  options: {
    platform?: NodeJS.Platform
    copyEntry?: (source: string, destination: string) => Promise<void>
  } = {}
): Promise<void> {
  if ((options.platform ?? process.platform) !== 'win32') {
    await cp(source, destination, { recursive: true })
    return
  }
  await copyWindowsEntry(
    source,
    destination,
    createLimiter(WINDOWS_COPY_CONCURRENCY),
    options.copyEntry ?? ((source, destination) => cp(source, destination))
  )
}

interface LimitedRunner {
  run<Result>(task: () => Promise<Result>): Promise<Result>
  abort(error: unknown): void
}

function createLimiter(limit: number): LimitedRunner {
  let active = 0
  let failed = false
  let failure: unknown
  const waiting: Array<(admitted: boolean) => void> = []
  const rejectWaiting = () => {
    for (const admit of waiting.splice(0)) admit(false)
  }
  return {
    async run(task) {
      if (failed) throw failure
      if (active >= limit) {
        const admitted = await new Promise<boolean>(resolve => waiting.push(resolve))
        if (!admitted || failed) throw failure
      }
      if (failed) throw failure
      active += 1
      try {
        return await task()
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
          rejectWaiting()
        }
        throw error
      } finally {
        active -= 1
        waiting.shift()?.(true)
      }
    },
    abort(error) {
      if (failed) return
      failed = true
      failure = error
      rejectWaiting()
    },
  }
}

async function copyWindowsEntry(
  source: string,
  destination: string,
  run: LimitedRunner,
  copyEntry: (source: string, destination: string) => Promise<void>
): Promise<void> {
  try {
    const metadata = await lstat(source)
    if (metadata.isSymbolicLink()) {
      // pnpm's Windows package cleanup traverses junctions. Managed packages
      // must own their files so cleanup cannot delete shared component assets.
      await copyWindowsEntry(await realpath(source), destination, run, copyEntry)
      return
    }
    if (!metadata.isDirectory()) {
      await run.run(() => copyEntry(source, destination))
      return
    }
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const entries = await readdir(source)
    // Windows profile preparation copies thousands of small files. Bounded
    // parallelism keeps it fast without exhausting handles. The publication
    // caller removes the destination after this function settles, so every
    // active copy must stop before a failure can propagate.
    const results = await Promise.allSettled(
      entries.map(entry =>
        copyWindowsEntry(join(source, entry), join(destination, entry), run, copyEntry)
      )
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (rejected) throw rejected.reason
  } catch (error) {
    run.abort(error)
    throw error
  }
}
