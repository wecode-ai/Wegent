import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const MAX_METADATA_BYTES = 1024 * 1024
export const digest = value => createHash('sha256').update(value).digest('hex')

export async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function readJson(path) {
  const file = await open(path, 'r')
  try {
    if ((await file.stat()).size > MAX_METADATA_BYTES) throw new Error('Metadata exceeds 1 MiB')
    return JSON.parse(await file.readFile('utf8'))
  } finally {
    await file.close()
  }
}

export async function optionalJson(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function writeJson(path, value, { modifiedAt } = {}) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > MAX_METADATA_BYTES) throw new Error('Metadata exceeds 1 MiB')
  const temporary = path + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(bytes)
      if (modifiedAt !== undefined) await file.utimes(modifiedAt / 1000, modifiedAt / 1000)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
}
