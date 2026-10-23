import { existsSync, watch as nativeWatch } from 'node:fs'
import path from 'node:path'

/** Serialize fresh builds so emitted asset references never cross build generations. */
export async function watchDevelopmentBuild({
  directories,
  files,
  ignored = [],
  build,
  onError,
  debounceMs = 350,
  watch = nativeWatch,
}) {
  const watchers = []
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
    const watcher = watch(directory, { recursive }, (_event, filename) => {
      if (!filename) return schedule()
      const resolved = path.resolve(directory, String(filename))
      if (!excluded(resolved, directory) && accept(resolved)) schedule()
    })
    watcher.on('error', onError)
    watchers.push(watcher)
  }
  for (const directory of directories) observe(directory, true, () => true)
  const parents = new Map()
  for (const file of files) {
    const parent = path.dirname(file)
    const names = parents.get(parent) ?? new Set()
    names.add(file)
    parents.set(parent, names)
  }
  for (const [parent, names] of parents) observe(parent, false, filename => names.has(filename))
  running = build()
  try {
    await running
  } catch (error) {
    for (const watcher of watchers) watcher.close()
    throw error
  } finally {
    running = undefined
  }
  if (pending) schedule()
  return {
    async close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      await running
    },
  }
}
