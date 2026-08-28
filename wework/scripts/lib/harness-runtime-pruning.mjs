import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const TARGET_NATIVE_ARTIFACTS = {
  'linux-arm64': { nodePty: 'linux-arm64', reflink: null },
  'linux-x64': { nodePty: 'linux-x64', reflink: null },
  'macos-arm64': { nodePty: 'darwin-arm64', reflink: 'reflink-darwin-arm64' },
  'macos-x64': { nodePty: 'darwin-x64', reflink: 'reflink-darwin-x64' },
  'windows-x64': { nodePty: 'win32-x64', reflink: 'reflink-win32-x64-msvc' },
}

const NON_RUNTIME_SUFFIXES = ['.d.cts', '.d.mts', '.d.ts', '.map']

export async function pruneHarnessRuntime(root, target) {
  const nativeArtifacts = TARGET_NATIVE_ARTIFACTS[target]
  if (!nativeArtifacts) throw new Error(`Unsupported Harness runtime prune target: ${target}`)
  const removed = { directories: 0, files: 0 }
  await visit(root, nativeArtifacts, removed)
  return removed
}

async function visit(directory, nativeArtifacts, removed) {
  const directoryName = basename(directory)
  const parentName = basename(dirname(directory))
  if (parentName === 'node-pty' && directoryName === 'third_party') {
    await rm(directory, { recursive: true, force: true })
    removed.directories += 1
    return
  }
  if (parentName === 'node-pty' && directoryName === 'prebuilds') {
    await removeOtherDirectories(directory, nativeArtifacts.nodePty, removed)
    return
  }
  if (directoryName === '@reflink') {
    await removeOtherDirectories(directory, nativeArtifacts.reflink, removed, 'reflink-')
  }

  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries.map(async entry => {
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(child, nativeArtifacts, removed)
      } else if (
        entry.isFile() &&
        NON_RUNTIME_SUFFIXES.some(suffix => entry.name.endsWith(suffix))
      ) {
        await rm(child, { force: true })
        removed.files += 1
      }
    })
  )
}

async function removeOtherDirectories(directory, retained, removed, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(
    entries
      .filter(
        entry =>
          entry.isDirectory() &&
          entry.name.startsWith(prefix) &&
          (retained === null || entry.name !== retained)
      )
      .map(async entry => {
        await rm(join(directory, entry.name), { recursive: true, force: true })
        removed.directories += 1
      })
  )
}
