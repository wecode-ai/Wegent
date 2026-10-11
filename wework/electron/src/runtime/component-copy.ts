import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileOperationQueue } from './file-operation-queue.js'
import {
  hashComponentFileContents,
  hashComponentRecords,
  validateComponentSymlink,
} from './component-content-hash.js'

export async function copyComponentTree(source: string, destination: string): Promise<string> {
  const run = createFileOperationQueue()
  const copy = async (relative: string): Promise<string> => {
    const from = join(source, relative)
    const to = join(destination, relative)
    const metadata = await run(() => lstat(from))
    if (!metadata.isDirectory()) throw new Error(`Unsupported component tree entry: ${from}`)
    await run(() => mkdir(to, { mode: metadata.mode | 0o700 }))
    const entries = await run(() => readdir(from, { withFileTypes: true }))
    const results = await Promise.allSettled(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async entry => {
          const child = join(relative, entry.name)
          const sourcePath = join(from, entry.name)
          const targetPath = join(to, entry.name)
          if (entry.isDirectory()) return `directory:${child}\0${await copy(child)}\0`
          else if (entry.isFile()) {
            const digest = await run(async () => {
              await copyFile(
                sourcePath,
                targetPath,
                constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE
              )
              return hashComponentFileContents(targetPath)
            })
            return `file:${child}\0${digest}\0`
          } else if (entry.isSymbolicLink()) {
            const target = await run(() => readlink(sourcePath))
            validateComponentSymlink(source, child, target)
            await run(() => symlink(target, targetPath))
            return `symlink:${child}\0${target}\0`
          } else throw new Error(`Unsupported component tree entry: ${sourcePath}`)
        })
    )
    const records: string[] = []
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason
      records.push(result.value)
    }
    await run(() => chmod(to, metadata.mode))
    return hashComponentRecords(records)
  }
  return copy('')
}
