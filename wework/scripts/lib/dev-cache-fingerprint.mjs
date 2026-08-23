import { readFile } from 'node:fs/promises'

export async function updateHashWithFileState(hash, pathname) {
  try {
    hash.update(await readFile(pathname))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    hash.update('<deleted>')
  }
}
