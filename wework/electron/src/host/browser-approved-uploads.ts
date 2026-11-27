import { constants, createWriteStream, type BigIntStats } from 'node:fs'
import { chmod, mkdtemp, open, rm, stat, statfs, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { approvalTargetChanged } from './browser-approved-targets.js'

// Chromium may consume a selected File long after DOM.setFileInputFiles returns.
// Keep confirmed snapshots for the manager's lifetime while reserving the minimum
// free space required by the Executor updater (150 MiB).
const MIN_FREE_DISK_BYTES = 150n * 1024n * 1024n

export interface ApprovedUploadFile {
  realPath: string
  fileIdentity: string
  size: bigint
}

export interface ApprovedUploadSnapshot {
  path: string
  discard(): Promise<void>
}

export function uploadFileIdentity(metadata: BigIntStats): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`
}

export class BrowserApprovedUploads {
  private directory: Promise<string> | undefined
  private reservedBytes = 0n
  private readonly pending = new Set<Promise<ApprovedUploadSnapshot>>()
  private readonly shutdown = new AbortController()

  constructor(private readonly temporaryDirectory = tmpdir()) {}

  create(file: ApprovedUploadFile, signal: AbortSignal): Promise<ApprovedUploadSnapshot> {
    if (this.shutdown.signal.aborted || signal.aborted) {
      return Promise.reject(new Error('Browser operation cancelled'))
    }
    if (file.size < 0n || file.size > BigInt(Number.MAX_SAFE_INTEGER))
      return Promise.reject(snapshotUnavailable('The approved file is too large to stage safely.'))
    const operation = this.copy(file, AbortSignal.any([signal, this.shutdown.signal]))
    this.pending.add(operation)
    return operation.finally(() => this.pending.delete(operation))
  }

  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending)
    const directory = await this.directory
    if (directory) await rm(directory, { recursive: true, force: true })
  }

  private root(): Promise<string> {
    if (this.directory) return this.directory
    const creating = mkdtemp(join(this.temporaryDirectory, 'wework-browser-uploads-')).then(
      async directory => {
        try {
          await chmod(directory, 0o700)
          return directory
        } catch (error) {
          await rm(directory, { recursive: true, force: true })
          throw error
        }
      }
    )
    this.directory = creating
    void creating.catch(() => {
      if (this.directory === creating) this.directory = undefined
    })
    return creating
  }

  private async copy(
    file: ApprovedUploadFile,
    signal: AbortSignal
  ): Promise<ApprovedUploadSnapshot> {
    let directory: string | undefined
    let reserved = false
    const discard = async (): Promise<void> => {
      if (directory) await rm(directory, { recursive: true, force: true })
      directory = undefined
    }
    try {
      signal.throwIfAborted()
      const source = await open(
        file.realPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      ).catch(() => {
        throw approvalTargetChanged('The approved local file could not be opened.')
      })
      try {
        const before = await source.stat({ bigint: true })
        if (
          !before.isFile() ||
          uploadFileIdentity(before) !== file.fileIdentity ||
          before.size !== file.size
        ) {
          throw approvalTargetChanged('The approved local file changed before upload.')
        }
        signal.throwIfAborted()
        const root = await this.root()
        const disk = await statfs(root, { bigint: true }).catch(() => {
          throw snapshotUnavailable(
            'Available space for the approved browser upload could not be verified.'
          )
        })
        if (disk.bavail * disk.bsize - this.reservedBytes - file.size < MIN_FREE_DISK_BYTES) {
          throw snapshotUnavailable(
            'There is insufficient disk space to retain the approved browser upload.'
          )
        }
        this.reservedBytes += file.size
        reserved = true
        signal.throwIfAborted()
        directory = await mkdtemp(join(root, 'file-'))
        const path = join(directory, basename(file.realPath))
        if (file.size === 0n) {
          await writeFile(path, '', { flag: 'wx', mode: 0o600, signal })
        } else {
          await pipeline(
            source.createReadStream({ start: 0, end: Number(file.size) - 1, autoClose: false }),
            createWriteStream(path, { flags: 'wx', mode: 0o600 }),
            { signal }
          )
        }
        const after = await source.stat({ bigint: true })
        const copied = await stat(path, { bigint: true })
        if (uploadFileIdentity(after) !== file.fileIdentity || copied.size !== file.size) {
          throw approvalTargetChanged('The approved local file changed while preparing the upload.')
        }
        await utimes(path, before.atime, before.mtime)
        signal.throwIfAborted()
        return { path, discard }
      } finally {
        await source.close()
      }
    } catch (error) {
      await discard()
      if ((error as { code?: unknown })?.code === 'ENOSPC') {
        throw snapshotUnavailable(
          'There is insufficient disk space to retain the approved browser upload.'
        )
      }
      throw error
    } finally {
      if (reserved) this.reservedBytes -= file.size
    }
  }
}

function snapshotUnavailable(message: string): Error {
  return Object.assign(new Error(message), { code: 'upload_snapshot_unavailable' })
}
