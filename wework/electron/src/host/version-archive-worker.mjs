import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { inflateRaw } from 'node:zlib'
import { workerData } from 'node:worker_threads'

import { assertReleasePath } from './version-release-path.mjs'

if (workerData?.kind !== 'wework-version-extraction-v2') {
  throw new Error('Invalid version extraction worker request')
}

// Load dependencies with normal ASAR support first. This flag belongs only to this worker.
const yauzl = createRequire(import.meta.url)('yauzl')
process.noAsar = true
const inflateRawAsync = promisify(inflateRaw)
const openZip = promisify(yauzl.open)
const MAX_ENTRIES = 100_000
const MAX_UNPACKED_BYTES = 16 * 1024 ** 3

function entryMode(entry) {
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

function isDirectoryEntry(entry) {
  return (
    entry.fileName.endsWith('/') ||
    (entryMode(entry) & 0o170000) === 0o040000 ||
    // Windows archives may mark directories only through this legacy value.
    (entry.versionMadeBy >> 8 === 0 && entry.externalFileAttributes === 16)
  )
}

function isSymbolicLink(entry) {
  return (entryMode(entry) & 0o170000) === 0o120000
}

function readCompressed(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, { decompress: false }, (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      const chunks = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  })
}

async function extractEntry(zip, entry, names, unpackedBytes) {
  if (entry.isEncrypted()) {
    throw new Error('Update archive contains an encrypted entry')
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(`Unsupported update archive compression: ${entry.compressionMethod}`)
  }
  const name = entry.fileName.replace(/\/$/, '')
  assertReleasePath(name)
  if (names.size >= MAX_ENTRIES || names.has(name.toLowerCase())) {
    throw new Error('Update archive contains duplicate files')
  }
  if (isSymbolicLink(entry)) {
    throw new Error('Update archive contains symbolic links')
  }
  names.add(name.toLowerCase())
  unpackedBytes.total += entry.uncompressedSize
  if (unpackedBytes.total > MAX_UNPACKED_BYTES) {
    throw new Error('Update archive is too large')
  }

  const destination = join(workerData.destination, name)
  const mode = entryMode(entry) & 0o777
  if (isDirectoryEntry(entry)) {
    await mkdir(destination, { recursive: true, mode: mode || 0o755 })
    return
  }

  // Electron's streaming zlib inflater stalls on large entries, so inflate the
  // validated compressed payload in one pass. The declared size bounds output.
  let data = await readCompressed(zip, entry)
  if (entry.compressionMethod === 8) {
    data = await inflateRawAsync(data, {
      maxOutputLength: Math.max(entry.uncompressedSize, 1),
    })
  }
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`Update archive extracted size mismatch: ${name}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, data, { mode: mode || 0o644 })
}

async function extractArchive() {
  const zip = await openZip(workerData.archive, {
    lazyEntries: true,
    validateEntrySizes: false,
  })
  const names = new Set()
  const unpackedBytes = { total: 0 }
  let failed = false
  try {
    await new Promise((resolve, reject) => {
      const fail = error => {
        if (failed) return
        failed = true
        reject(error)
      }
      zip.on('entry', entry => {
        extractEntry(zip, entry, names, unpackedBytes).then(() => {
          if (!failed) zip.readEntry()
        }, fail)
      })
      zip.on('error', fail)
      zip.on('end', resolve)
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

await extractArchive()
