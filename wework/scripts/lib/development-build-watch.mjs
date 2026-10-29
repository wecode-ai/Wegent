import { watch } from 'chokidar'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { developmentBuildInputs } from './development-build-inputs.mjs'

/** Serialize fresh builds so emitted asset references never cross build generations. */
export async function watchDevelopmentBuild({
  directories,
  files,
  ignored = [],
  build,
  onError,
  debounceMs = 350,
}) {
  const watchers = []
  const readiness = []
  let closed = false
  let pending = false
  let timer
  let running
  const excluded = (filename, directory) =>
    ignored.some(root => filename === root || filename.startsWith(`${root}${path.sep}`)) ||
    path
      .relative(directory, filename)
      .split(path.sep)
      .some(part => ['node_modules', '.git', 'dist'].includes(part))
  let inputChanged
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
  const schedule = () => {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (running) {
        pending = true
        return
      }
      running = drain().finally(() => {
        running = undefined
      })
    }, debounceMs)
  }
  const observe = (directory, recursive, accept) => {
    if (!existsSync(directory)) return
    // Chokidar rearms replaced inodes after atomic editor saves on Linux.
    const watcher = watch(directory, {
      ignoreInitial: true,
      disableGlobbing: true,
      // Stabilize complete inputs before the cross-file build debounce.
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
        pollInterval: Math.max(1, Math.min(debounceMs, 100)),
      },
      ...(recursive ? {} : { depth: 0 }),
      ignored: filename => excluded(path.resolve(filename), directory),
    })
    watcher.on('all', (_event, filename) => {
      const resolved = path.resolve(filename)
      if (excluded(resolved, directory) || !accept(resolved)) return
      // The initial build reads edits observed before the startup snapshot.
      if (!inputChanged) return
      try {
        if (inputChanged(resolved, directory)) schedule()
      } catch (error) {
        onError(error)
      }
    })
    watcher.on('error', onError)
    watchers.push(watcher)
    readiness.push(once(watcher, 'ready'))
  }
  try {
    for (const directory of directories) observe(directory, true, () => true)
    const parents = new Map()
    for (const file of files) {
      const parent = path.dirname(file)
      const names = parents.get(parent) ?? new Set()
      names.add(file)
      parents.set(parent, names)
    }
    for (const [parent, names] of parents) observe(parent, false, filename => names.has(filename))
    await Promise.all(readiness)
    inputChanged = developmentBuildInputs({ directories, files, excluded })
    running = build()
    await running
  } catch (error) {
    closed = true
    clearTimeout(timer)
    await Promise.all(watchers.map(watcher => watcher.close()))
    throw error
  } finally {
    running = undefined
  }
  if (pending) schedule()
  return {
    async close() {
      closed = true
      clearTimeout(timer)
      await Promise.all(watchers.map(watcher => watcher.close()))
      await running
    },
  }
}
