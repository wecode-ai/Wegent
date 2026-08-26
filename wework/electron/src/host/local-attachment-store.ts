import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const MAX_LOCAL_ATTACHMENT_BYTES = 100 * 1024 * 1024
export const MAX_LOCAL_ATTACHMENT_CHUNK_BYTES = 384 * 1024

interface AttachmentUpload {
  directory: string
  path: string
  filename: string
  expectedSize: number
  offset: number
}

export interface AttachmentUploadStarted {
  uploadId: string
  chunkSize: number
}

export class LocalAttachmentStore {
  private readonly stagingRoot: string
  private readonly uploads = new Map<string, AttachmentUpload>()
  private initialized: Promise<void> | null = null

  constructor(private readonly root: string) {
    this.stagingRoot = join(root, '.uploading')
  }

  async begin(filename: string, size: number): Promise<AttachmentUploadStarted> {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_LOCAL_ATTACHMENT_BYTES) {
      throw new Error('Attachment size is invalid')
    }
    await this.initialize()
    const uploadId = randomUUID()
    const directory = join(this.stagingRoot, uploadId)
    const safeFilename = sanitizeAttachmentFilename(filename)
    const path = join(directory, safeFilename)
    await mkdir(directory, { recursive: false })
    await writeFile(path, new Uint8Array())
    this.uploads.set(uploadId, {
      directory,
      path,
      filename: safeFilename,
      expectedSize: size,
      offset: 0,
    })
    return { uploadId, chunkSize: MAX_LOCAL_ATTACHMENT_CHUNK_BYTES }
  }

  async append(uploadId: string, offset: number, chunkBase64: string): Promise<number> {
    const upload = this.requireUpload(uploadId)
    if (!Number.isSafeInteger(offset) || offset !== upload.offset) {
      throw new Error('Attachment chunk offset is invalid')
    }
    if (!isCanonicalBase64(chunkBase64)) {
      throw new Error('Attachment chunk is not valid base64')
    }
    const chunk = Buffer.from(chunkBase64, 'base64')
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_LOCAL_ATTACHMENT_CHUNK_BYTES) {
      throw new Error('Attachment chunk size is invalid')
    }
    if (upload.offset + chunk.byteLength > upload.expectedSize) {
      throw new Error('Attachment exceeds its declared size')
    }
    await appendFile(upload.path, chunk)
    upload.offset += chunk.byteLength
    return upload.offset
  }

  async finish(uploadId: string): Promise<string> {
    const upload = this.requireUpload(uploadId)
    if (upload.offset !== upload.expectedSize) {
      throw new Error('Attachment upload is incomplete')
    }
    const metadata = await stat(upload.path)
    if (metadata.size !== upload.expectedSize) {
      throw new Error('Attachment size verification failed')
    }
    const finalDirectory = await this.allocateFinalDirectory()
    await rename(upload.directory, finalDirectory)
    this.uploads.delete(uploadId)
    return join(finalDirectory, upload.filename)
  }

  async abort(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) return
    this.uploads.delete(uploadId)
    await rm(upload.directory, { recursive: true, force: true })
  }

  private requireUpload(uploadId: string): AttachmentUpload {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      throw new Error('Attachment upload id is invalid')
    }
    const upload = this.uploads.get(uploadId)
    if (!upload) throw new Error('Attachment upload was not found')
    return upload
  }

  private initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        await mkdir(this.root, { recursive: true })
        await rm(this.stagingRoot, { recursive: true, force: true })
        await mkdir(this.stagingRoot, { recursive: true })
      })()
    }
    return this.initialized
  }

  private async allocateFinalDirectory(): Promise<string> {
    return join(this.root, `${Date.now()}-${randomUUID()}`)
  }
}

function sanitizeAttachmentFilename(filename: string): string {
  const leaf = Array.from(basename(filename.trim().replaceAll('\\', '/')))
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 31 || codePoint === 127 || '<>:"/\\|?*'.includes(character)
        ? '_'
        : character
    })
    .join('')
    .replace(/[. ]+$/g, '')
    .slice(0, 200)
  return leaf || 'attachment'
}

function isCanonicalBase64(value: string): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false
  }
  return Buffer.from(value, 'base64').toString('base64') === value
}
