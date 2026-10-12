import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function hashComponentPath(path) {
  const metadata = await lstat(path)
  if (metadata.isFile()) return fileSha256(path)
  if (!metadata.isDirectory()) throw new Error(`Unsupported component entry: ${path}`)
  return hashTree(path, '', createFileHasher())
}

async function hashTree(root, relative, hashFile) {
  const hash = createHash('sha256')
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  const records = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async entry => {
        const child = join(relative, entry.name)
        if (entry.isDirectory()) {
          return `directory:${child}\0${await hashTree(root, child, hashFile)}\0`
        } else if (entry.isFile()) {
          return `file:${child}\0${await hashFile(join(root, child))}\0`
        } else if (entry.isSymbolicLink()) {
          const target = await readlink(join(root, child))
          const destination = relativePath(resolve(root), resolve(root, dirname(child), target))
          if (
            isAbsolute(target) ||
            destination === '..' ||
            destination.split(/[\\/]/)[0] === '..'
          ) {
            throw new Error(`Component symlink escapes its root: ${child}`)
          }
          return `symlink:${child}\0${target}\0`
        } else {
          throw new Error(`Unsupported component entry: ${child}`)
        }
      })
  )
  for (const record of records) hash.update(record)
  return hash.digest('hex')
}

function createFileHasher() {
  let active = 0
  const waiting = []
  return async path => {
    if (active >= 8) await new Promise(resolve => waiting.push(resolve))
    else active += 1
    try {
      return await fileSha256(path)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
