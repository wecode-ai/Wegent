import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MAX_FILE_READS = 8

export type ComponentFileVisitor = (relativePath: string) => void

export async function hashComponentPath(
  path: string,
  onFile?: ComponentFileVisitor
): Promise<string> {
  const metadata = await lstat(path)
  if (metadata.isFile()) {
    onFile?.(basename(path))
    return sha256(path)
  }
  if (!metadata.isDirectory()) throw new Error(`Unsupported component entry: ${path}`)
  let active = 0
  const waiting: Array<() => void> = []
  const hashFile = async (file: string): Promise<string> => {
    if (active === MAX_FILE_READS) await new Promise<void>(resolve => waiting.push(resolve))
    else active += 1
    try {
      return await sha256(file)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
  return hashTree(path, '', hashFile, onFile)
}

async function hashTree(
  root: string,
  relative: string,
  hashFile: (path: string) => Promise<string>,
  onFile?: ComponentFileVisitor
): Promise<string> {
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  const contents = await Promise.all(
    entries.map(async entry => {
      // Preserve the digest format used by installed platform-native updaters.
      const child = join(relative, entry.name)
      if (entry.isDirectory())
        return `directory:${child}\0${await hashTree(root, child, hashFile, onFile)}\0`
      if (entry.isFile()) {
        onFile?.(child)
        return `file:${child}\0${await hashFile(join(root, child))}\0`
      }
      throw new Error(`Unsupported component tree entry: ${child}`)
    })
  )
  const hash = createHash('sha256')
  for (const content of contents) hash.update(content)
  return hash.digest('hex')
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
