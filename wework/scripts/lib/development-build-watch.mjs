import { existsSync } from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import chokidar from 'chokidar'
import { developmentBuildInputs } from './development-build-inputs.mjs'

export function watchDevelopmentDirectory(
  directory,
  { recursive, ignored },
  notify,
  createWatcher = chokidar.watch
) {
  const watcher = createWatcher(directory, {
    ignoreInitial: true,
    depth: recursive ? undefined : 0,
    ignored,
  })
  watcher.on('all', (event, filename) => notify(event, path.relative(directory, filename)))
  // Node-backed normalized change events are throttled for 50 ms. Preserve
  // raw edits as well; the input snapshot deduplicates repeated notifications.
  watcher.on('raw', (event, filename, details) => {
    const watched = details?.watchedPath
    if (!watched) return
    const changed =
      !filename || path.basename(watched) === String(filename)
        ? watched
        : path.resolve(watched, String(filename))
    notify(
      event,
      changed === directory ? path.basename(directory) : path.relative(directory, changed)
    )
  })
  return {
    ready: once(watcher, 'ready'),
    on: (...args) => watcher.on(...args),
    close: () => watcher.close(),
  }
}

/** Serialize fresh builds so emitted asset references never cross build generations. */
export async function watchDevelopmentBuild({
  directories,
  files,
  ignored = [],
  build,
  onError,
  debounceMs = 350,
  watchDirectory = watchDevelopmentDirectory,
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
    const watcher = watchDirectory(
      directory,
      {
        recursive,
        ignored: filename => excluded(path.resolve(filename), directory),
      },
      (_event, filename) => {
        // The initial build reads all inputs after subscriptions become ready.
        if (!inputChanged) return
        if (!filename) return schedule()
        const name = String(filename)
        const resolved =
          recursive && name === path.basename(directory) ? directory : path.resolve(directory, name)
        if (excluded(resolved, directory) || !accept(resolved)) return
        try {
          if (inputChanged(resolved, directory)) schedule()
        } catch (error) {
          onError(error)
        }
      }
    )
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
  try {
    await Promise.all(watchers.map(watcher => watcher.ready))
    inputChanged = developmentBuildInputs({ directories, files, excluded })
    running = build()
    await running
  } catch (error) {
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
