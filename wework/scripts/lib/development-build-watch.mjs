import { existsSync, statSync, watch } from 'node:fs'
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
  const roots = directories.map(directory => path.resolve(directory))
  const sourceFiles = files.map(file => path.resolve(file))
  const exclusions = ignored.map(directory => path.resolve(directory))
  let closed = false
  let pending = false
  let timer
  let running
  const excluded = (filename, directory) =>
    exclusions.some(root => filename === root || filename.startsWith(`${root}${path.sep}`)) ||
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
  const observer = createDirectoryObserver({
    excluded,
    onUnknown: schedule,
    onError,
    onChange: (filename, directory) => {
      try {
        if (inputChanged?.(filename, directory)) schedule()
      } catch (error) {
        onError(error)
      }
    },
  })
  const parents = new Map()
  for (const file of sourceFiles) {
    const parent = path.dirname(file)
    const names = parents.get(parent) ?? new Set()
    names.add(file)
    parents.set(parent, names)
  }
  try {
    for (const [parent, names] of parents) {
      if (existsSync(parent))
        observer.observe(
          parent,
          parent,
          statSync(parent, { bigint: true }),
          filename => names.has(filename),
          `files\0${parent}`
        )
    }
    inputChanged = developmentBuildInputs({
      directories: roots,
      files: sourceFiles,
      excluded,
      onDirectory: (directory, root, stat) => observer.observe(directory, root, stat),
    })
    running = build()
    await running
  } catch (error) {
    closed = true
    clearTimeout(timer)
    observer.close()
    throw error
  } finally {
    running = undefined
  }
  if (pending) schedule()
  return {
    async close() {
      closed = true
      clearTimeout(timer)
      observer.close()
      await running
    },
  }
}

function createDirectoryObserver({ excluded, onChange, onUnknown, onError }) {
  const watchers = new Map()
  const observe = (directory, root, stat, accept = () => true, key = `${root}\0${directory}`) => {
    const previous = watchers.get(key)
    if (previous?.ino === stat.ino) return
    watchers.delete(key)
    previous?.watcher.close()
    let watcher
    try {
      // Directory inodes survive atomic file saves; recursive fs.watch on Linux
      // attaches to file inodes and can miss the next replacement.
      watcher = watch(directory, { recursive: false }, (_event, filename) => {
        try {
          const current = statSync(directory, { bigint: true, throwIfNoEntry: false })
          if (!current?.isDirectory()) {
            if (watchers.get(key)?.watcher === watcher) watchers.delete(key)
            watcher.close()
            if (accept(directory)) onChange(directory, root)
            return
          }
          if (current.ino !== stat.ino) {
            observe(directory, root, current, accept, key)
            if (accept(directory)) onChange(directory, root)
            else onUnknown()
            return
          }
          if (!filename) {
            if (accept(directory)) onChange(directory, root)
            else onUnknown()
            return
          }
          const resolved = path.resolve(directory, String(filename))
          if (!excluded(resolved, root) && accept(resolved)) onChange(resolved, root)
        } catch (error) {
          onError(error)
        }
      })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    const entry = { watcher, ino: stat.ino }
    watchers.set(key, entry)
    watcher.on('error', onError)
    watcher.once('close', () => {
      if (watchers.get(key) === entry) watchers.delete(key)
    })
  }
  return {
    observe,
    close() {
      for (const { watcher } of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
