import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Publish owner-only bytes only after the file and directory have been synchronized. */
export async function durableWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(contents, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    // Windows does not support opening a directory for fsync.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
