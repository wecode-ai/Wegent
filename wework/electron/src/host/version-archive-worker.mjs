import { workerData } from 'node:worker_threads'
import extractZip from 'extract-zip'
import { assertReleasePath } from './version-release-path.mjs'

if (workerData?.kind !== 'wework-version-extraction-v2') {
  throw new Error('Invalid version extraction worker request')
}

// Load dependencies with normal ASAR support first. This flag belongs only to this worker.
process.noAsar = true
const names = new Set()
let unpackedBytes = 0
await extractZip(workerData.archive, {
  dir: workerData.destination,
  onEntry: entry => {
    const path = entry.fileName.replace(/\/$/, '')
    assertReleasePath(path)
    if (
      names.size >= 100_000 ||
      names.has(path.toLowerCase()) ||
      ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
    )
      throw new Error('Update archive contains duplicate files or symbolic links')
    names.add(path.toLowerCase())
    unpackedBytes += entry.uncompressedSize
    if (unpackedBytes > 16 * 1024 ** 3) throw new Error('Update archive is too large')
  },
})
