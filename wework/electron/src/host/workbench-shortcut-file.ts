import { lstat, open } from 'node:fs/promises'
import { readBoundedFile } from './bounded-file-reader.js'

export async function ownsWorkbenchShortcutFile(path: string, content: string): Promise<boolean> {
  return (await readWorkbenchShortcutFile(path)) === content
}

export async function readWorkbenchShortcutFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > 64 * 1024) return null
    const handle = await open(path, 'r')
    try {
      const current = await handle.stat()
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) return null
      return (await readBoundedFile(handle, 64 * 1024)).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  }
}
