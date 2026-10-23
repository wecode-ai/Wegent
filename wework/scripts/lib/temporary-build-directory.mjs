import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Settle every writer before consuming or removing the shared temporary output. */
export async function withTemporaryBuildDirectory({ prefix, builds, consume }) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  try {
    const results = await Promise.allSettled(
      builds.map(build => Promise.resolve().then(() => build(directory)))
    )
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
    return await consume(
      results.map(result => result.value),
      directory
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
