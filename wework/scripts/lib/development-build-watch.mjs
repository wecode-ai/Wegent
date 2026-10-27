import path from 'node:path'
import { developmentBuildInputs } from './development-build-inputs.mjs'

/** Serialize fresh builds so emitted asset references never cross build generations. */
export async function watchDevelopmentBuild({
  directories,
  files,
  ignored = [],
  build,
  onError,
  intervalMs = 350,
}) {
  let closed = false
  let pending = false
  let running
  const excluded = (filename, directory) =>
    ignored.some(root => filename === root || filename.startsWith(`${root}${path.sep}`)) ||
    path
      .relative(directory, filename)
      .split(path.sep)
      .some(part => ['node_modules', '.git', 'dist'].includes(part))
  const inputChanged = developmentBuildInputs({ directories, files, excluded })
  const inputs = directories
    .map(directory => [directory, directory])
    .concat(files.map(filename => [filename, path.dirname(filename)]))
  const drain = async () => {
    do {
      pending = false
      try {
        await build()
      } catch (error) {
        onError(error)
      }
    } while (pending && !closed)
  }
  // Native directory subscriptions have no readiness signal on macOS and can
  // lose the first edit. Compare the existing input snapshots as the sole source.
  const timer = setInterval(() => {
    try {
      let changed = false
      for (const [filename, directory] of inputs) {
        if (inputChanged(filename, directory)) changed = true
      }
      if (!changed) return
      if (running) {
        pending = true
        return
      }
      running = drain().finally(() => {
        running = undefined
      })
    } catch (error) {
      onError(error)
    }
  }, intervalMs)
  try {
    running = build()
    await running
  } catch (error) {
    clearInterval(timer)
    throw error
  } finally {
    running = undefined
  }
  if (pending) {
    running = drain().finally(() => {
      running = undefined
    })
  }
  return {
    async close() {
      closed = true
      clearInterval(timer)
      await running
    },
  }
}
