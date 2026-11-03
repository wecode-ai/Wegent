import assert from 'node:assert/strict'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** Move opaque credentials without reading or exposing their contents. */
export function nativeCloudCredentialSnapshot(userDataDirectory, id) {
  assert.match(id, /^[a-f0-9-]{36}$/)
  const directory = join(userDataDirectory, `.mcp-app-auth-${id}`)
  const original = join(directory, 'original')
  const empty = join(directory, 'empty')
  const active = join(userDataDirectory, 'cloud-credentials.json')
  return {
    async capture() {
      await mkdir(directory, { mode: 0o700 })
      try {
        await rename(active, original)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await writeFile(empty, '', { flag: 'wx', mode: 0o600 })
      }
    },
    async restore() {
      if ((await exists(original)) || (await exists(empty))) {
        await rm(active, { force: true })
        if (await exists(original)) await rename(original, active)
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}
