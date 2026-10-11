import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { hashComponentPath } from './component-content-hash.js'
import { copyComponentTree } from './component-copy.js'

export async function copyComponentSnapshot(
  source: string,
  target: string,
  requestedEntryPath?: string
) {
  const metadata = await stat(source)
  const entryPath = requestedEntryPath ?? (metadata.isDirectory() ? '.' : basename(source))
  const destination = join(target, entryPath)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (metadata.isDirectory()) {
    return { entryPath, contentSha256: await copyComponentTree(source, destination) }
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  return { entryPath, contentSha256: await hashComponentPath(destination) }
}

export async function cachePackagedComponent(root: string, version: string, source: string) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temporary = join(root, `${process.pid}.${randomUUID()}.tmp`)
  try {
    // Hash the independent snapshot once, including post-signing binary bytes.
    const snapshot = await copyComponentSnapshot(source, temporary)
    const target = join(root, snapshot.contentSha256)
    let matches = false
    try {
      matches =
        (await hashComponentPath(join(target, snapshot.entryPath))) === snapshot.contentSha256
    } catch {
      // Missing or invalid snapshots are replaced only after the new copy is complete.
    }
    if (!matches) {
      await rm(target, { recursive: true, force: true })
      await rename(temporary, target)
    }
    return {
      ...snapshot,
      version,
      archiveSha256: snapshot.contentSha256,
      archiveBytes: 1,
      downloadUrl: 'local://packaged-component',
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
