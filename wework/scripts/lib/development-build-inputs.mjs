import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// fs.watch can deliver pre-subscription events after the initial build starts.
// Compare input versions so delayed or duplicate events do not rebuild unchanged inputs.
export function developmentBuildInputs({ directories, files, excluded }) {
  const versions = new Map()
  const collect = (filename, directory, snapshot) => {
    if (excluded(filename, directory)) return
    let stat
    try {
      stat = statSync(filename, { bigint: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(filename)) {
        collect(path.join(filename, name), directory, snapshot)
      }
    } else {
      snapshot.set(filename, `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.mode}`)
    }
  }
  for (const directory of directories) collect(directory, directory, versions)
  for (const filename of files) collect(filename, path.dirname(filename), versions)
  return (filename, directory) => {
    const next = new Map()
    collect(filename, directory, next)
    let changed = false
    for (const [name, version] of next) {
      if (versions.get(name) !== version) changed = true
    }
    for (const name of versions.keys()) {
      if (name !== filename && !name.startsWith(`${filename}${path.sep}`)) continue
      if (!next.has(name)) {
        changed = true
        versions.delete(name)
      }
    }
    for (const [name, version] of next) versions.set(name, version)
    return changed
  }
}
