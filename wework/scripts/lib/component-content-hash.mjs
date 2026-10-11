import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative as relativePath, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

export async function hashComponentPath(path) {
  const metadata = await lstat(path)
  if (metadata.isFile()) return fileSha256(path)
  if (!metadata.isDirectory()) throw new Error(`Unsupported component entry: ${path}`)
  return hashTree(path)
}

async function hashTree(root, relative = '') {
  const hash = createHash('sha256')
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) {
      hash.update(`directory:${child}\0${await hashTree(root, child)}\0`)
    } else if (entry.isFile()) {
      hash.update(`file:${child}\0${await fileSha256(join(root, child))}\0`)
    } else if (entry.isSymbolicLink()) {
      const target = await readlink(join(root, child))
      const destination = relativePath(resolve(root), resolve(root, dirname(child), target))
      if (isAbsolute(target) || destination === '..' || destination.split(/[\\/]/)[0] === '..') {
        throw new Error(`Component symlink escapes its root: ${child}`)
      }
      hash.update(`symlink:${child}\0${target}\0`)
    } else {
      throw new Error(`Unsupported component entry: ${child}`)
    }
  }
  return hash.digest('hex')
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
