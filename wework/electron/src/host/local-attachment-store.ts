import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const MAX_LOCAL_ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024
const MAX_COMPLETED_ATTACHMENT_UPLOADS = 256

interface AttachmentUpload {
  directory: string
  path: string
  filename: string
  expectedSize: number
  offset: number
  lastAppend?: {
    id: string
    offset: number
    digest: string
  }
}

export interface AttachmentUploadStarted {
  uploadId: string
  chunkSize: number
}

export class LocalAttachmentStore {
  private readonly stagingRoot: string
  private readonly uploads = new Map<string, AttachmentUpload>()
  private readonly startingUploads = new Map<
    string,
    { filename: string; size: number; request: Promise<AttachmentUploadStarted> }
  >()
  private readonly appendingChunks = new Map<
    string,
    { offset: number; chunkBase64: string; request: Promise<number> }
  >()
  private readonly finishingUploads = new Map<string, Promise<string>>()
  private readonly completedUploads = new Map<string, string>()
  private initialized: Promise<void> | null = null

  constructor(private readonly root: string) {
    this.stagingRoot = join(root, '.uploading')
  }

  async begin(
    filename: string,
    size: number,
    uploadId: string = randomUUID()
  ): Promise<AttachmentUploadStarted> {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error('Attachment size is invalid')
    }
    validateAttachmentId(uploadId)
    const safeFilename = sanitizeAttachmentFilename(filename)
    const existing = this.uploads.get(uploadId)
    if (existing) return this.existingUpload(uploadId, safeFilename, size, existing)
    const starting = this.startingUploads.get(uploadId)
    if (starting) {
      if (starting.filename !== safeFilename || starting.size !== size) {
        throw new Error('Attachment upload retry does not match the original request')
      }
      return starting.request
    }
    const request = (async () => {
      try {
        return await this.beginUpload(uploadId, safeFilename, size)
      } finally {
        this.startingUploads.delete(uploadId)
      }
    })()
    this.startingUploads.set(uploadId, { filename: safeFilename, size, request })
    return request
  }

  private async beginUpload(
    uploadId: string,
    safeFilename: string,
    size: number
  ): Promise<AttachmentUploadStarted> {
    await this.initialize()
    const existing = this.uploads.get(uploadId)
    if (existing) return this.existingUpload(uploadId, safeFilename, size, existing)
    const directory = join(this.stagingRoot, uploadId)
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

  private existingUpload(
    uploadId: string,
    safeFilename: string,
    size: number,
    upload: AttachmentUpload
  ): AttachmentUploadStarted {
    if (upload.filename !== safeFilename || upload.expectedSize !== size) {
      throw new Error('Attachment upload id was reused for a different file')
    }
    return { uploadId, chunkSize: MAX_LOCAL_ATTACHMENT_CHUNK_BYTES }
  }

  async append(
    uploadId: string,
    offset: number,
    chunkBase64: string,
    appendId?: string
  ): Promise<number> {
    if (appendId !== undefined) validateAttachmentId(appendId)
    const requestKey = appendId ? `${uploadId}:${appendId}` : null
    const existing = requestKey ? this.appendingChunks.get(requestKey) : undefined
    if (existing) {
      if (existing.offset !== offset || existing.chunkBase64 !== chunkBase64) {
        throw new Error('Attachment append retry does not match the original chunk')
      }
      return existing.request
    }
    const request = (async () => {
      try {
        return await this.appendChunk(uploadId, offset, chunkBase64, appendId)
      } finally {
        if (requestKey) this.appendingChunks.delete(requestKey)
      }
    })()
    if (requestKey) this.appendingChunks.set(requestKey, { offset, chunkBase64, request })
    return request
  }

  private async appendChunk(
    uploadId: string,
    offset: number,
    chunkBase64: string,
    appendId?: string
  ): Promise<number> {
    const upload = this.requireUpload(uploadId)
    if (!isCanonicalBase64(chunkBase64)) {
      throw new Error('Attachment chunk is not valid base64')
    }
    const chunk = Buffer.from(chunkBase64, 'base64')
    const chunkDigest = createHash('sha256').update(chunk).digest('hex')
    if (chunk.byteLength === 0 || chunk.byteLength > MAX_LOCAL_ATTACHMENT_CHUNK_BYTES) {
      throw new Error('Attachment chunk size is invalid')
    }
    if (appendId && upload.lastAppend?.id === appendId) {
      if (offset !== upload.lastAppend.offset || chunkDigest !== upload.lastAppend.digest) {
        throw new Error('Attachment append retry does not match the original chunk')
      }
      return upload.offset
    }
    if (!Number.isSafeInteger(offset) || offset !== upload.offset) {
      throw new Error('Attachment chunk offset is invalid')
    }
    if (upload.offset + chunk.byteLength > upload.expectedSize) {
      throw new Error('Attachment exceeds its declared size')
    }
    await appendFile(upload.path, chunk)
    upload.offset += chunk.byteLength
    if (appendId) {
      upload.lastAppend = { id: appendId, offset, digest: chunkDigest }
    }
    return upload.offset
  }

  async finish(uploadId: string): Promise<string> {
    const completedPath = this.completedUploads.get(uploadId)
    if (completedPath) return completedPath
    const finishingUpload = this.finishingUploads.get(uploadId)
    if (finishingUpload) return finishingUpload
    const request = (async () => {
      try {
        return await this.finishUpload(uploadId)
      } finally {
        this.finishingUploads.delete(uploadId)
      }
    })()
    this.finishingUploads.set(uploadId, request)
    return request
  }

  private async finishUpload(uploadId: string): Promise<string> {
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
    const path = join(finalDirectory, upload.filename)
    this.completedUploads.set(uploadId, path)
    if (this.completedUploads.size > MAX_COMPLETED_ATTACHMENT_UPLOADS) {
      const oldestUploadId = this.completedUploads.keys().next().value
      if (oldestUploadId) this.completedUploads.delete(oldestUploadId)
    }
    return path
  }

  async abort(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) return
    this.uploads.delete(uploadId)
    await rm(upload.directory, { recursive: true, force: true })
  }

  private requireUpload(uploadId: string): AttachmentUpload {
    validateAttachmentId(uploadId)
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

function validateAttachmentId(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('Attachment upload id is invalid')
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
