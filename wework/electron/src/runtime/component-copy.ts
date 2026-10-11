import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileOperationQueue } from './file-operation-queue.js'

export async function copyComponentTree(source: string, destination: string): Promise<void> {
  const run = createFileOperationQueue()
  const copy = async (from: string, to: string): Promise<void> => {
    const metadata = await run(() => lstat(from))
    if (metadata.isDirectory()) {
      await run(() => mkdir(to, { mode: metadata.mode | 0o700 }))
      const entries = await run(() => readdir(from, { withFileTypes: true }))
      const results = await Promise.allSettled(
        entries.map(async entry => {
          const sourcePath = join(from, entry.name)
          const targetPath = join(to, entry.name)
          if (entry.isDirectory()) await copy(sourcePath, targetPath)
          else if (entry.isFile()) {
            await run(() =>
              copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
            )
          } else if (entry.isSymbolicLink()) {
            const target = await run(() => readlink(sourcePath))
            await run(() => symlink(target, targetPath))
          } else throw new Error(`Unsupported component tree entry: ${sourcePath}`)
        })
      )
      for (const result of results) if (result.status === 'rejected') throw result.reason
      await run(() => chmod(to, metadata.mode))
    } else if (metadata.isFile()) {
      await run(() => copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE))
    } else if (metadata.isSymbolicLink()) {
      const target = await run(() => readlink(from))
      await run(() => symlink(target, to))
    } else {
      throw new Error(`Unsupported component tree entry: ${from}`)
    }
  }
  await copy(source, destination)
}
