import { readFile } from 'node:fs/promises'

export async function updateHashWithFileState(hash, pathname) {
  try {
    const contents = await readFile(pathname)
    hash.update('<present>')
    hash.update(contents)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    hash.update('<deleted>')
  }
}
