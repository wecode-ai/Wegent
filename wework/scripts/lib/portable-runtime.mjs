import { realpath, readdir } from 'node:fs/promises'
import path from 'node:path'

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')
}

async function validateDirectory(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      let target
      try {
        target = await realpath(entryPath)
      } catch {
        throw new Error(`Harness runtime contains a broken symlink: ${entryPath}`)
      }
      if (!isWithin(root, target)) {
        throw new Error(`Harness runtime symlink escapes the archive root: ${entryPath}`)
      }
    } else if (entry.isDirectory()) {
      await validateDirectory(root, entryPath)
    }
  }
}

export async function assertPortableHarnessRuntime(runtimeRoot) {
  const canonicalRoot = await realpath(runtimeRoot)
  await validateDirectory(canonicalRoot, canonicalRoot)
}
