import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MAX_FILE_READS = 8

/** @param {string} path @returns {Promise<string>} */
export async function hashComponentPath(path) {
  const metadata = await lstat(path)
  if (metadata.isFile()) return sha256(path)
  if (!metadata.isDirectory()) throw new Error(`Unsupported component entry: ${path}`)
  let active = 0
  /** @type {Array<() => void>} */
  const waiting = []
  const hashFile = async file => {
    if (active === MAX_FILE_READS) await new Promise(resolve => waiting.push(resolve))
    else active += 1
    try {
      return await sha256(file)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
  return hashTree(path, '', hashFile)
}

/**
 * @param {string} root
 * @param {string} relative
 * @param {(path: string) => Promise<string>} hashFile
 * @returns {Promise<string>}
 */
async function hashTree(root, relative, hashFile) {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const contents = await Promise.all(
    entries.map(async entry => {
      // Preserve the digest format used by installed platform-native updaters.
      const child = join(relative, entry.name)
      if (entry.isDirectory())
        return `directory:${child}\0${await hashTree(root, child, hashFile)}\0`
      if (entry.isFile()) return `file:${child}\0${await hashFile(join(root, child))}\0`
      throw new Error(`Unsupported component tree entry: ${child}`)
    })
  )
  const hash = createHash('sha256')
  for (const content of contents) hash.update(content)
  return hash.digest('hex')
}

/** @param {string} path @returns {Promise<string>} */
export async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
