import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { LocalAttachmentStore, MAX_LOCAL_ATTACHMENT_CHUNK_BYTES } from './local-attachment-store.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wework-attachments-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('LocalAttachmentStore', () => {
  test.each([100 * 1024 * 1024 + 1, 378989795])(
    'accepts a generated attachment of %i bytes and cleans up an aborted write',
    async size => {
      const root = await temporaryDirectory()
      const store = new LocalAttachmentStore(root)
      const started = await store.begin('generated.bin', size)
      const path = join(root, '.uploading', started.uploadId, 'generated.bin')

      await expect(store.append(started.uploadId, 0, 'YQ==')).resolves.toBe(1)
      await expect(readFile(path, 'utf8')).resolves.toBe('a')
      await expect(store.finish(started.uploadId)).rejects.toThrow(
        'Attachment upload is incomplete'
      )
      await store.abort(started.uploadId)

      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects the invalid declared size %s',
    async size => {
      const store = new LocalAttachmentStore(await temporaryDirectory())
      await expect(store.begin('invalid.bin', size)).rejects.toThrow('Attachment size is invalid')
    }
  )

  test('stores a verified chunked attachment under the draft root', async () => {
    const root = await temporaryDirectory()
    const store = new LocalAttachmentStore(root)
    const started = await store.begin('../unsafe?.txt', 5)

    await expect(
      store.append(started.uploadId, 0, Buffer.from('hello').toString('base64'))
    ).resolves.toBe(5)
    const path = await store.finish(started.uploadId)

    expect(path.startsWith(root)).toBe(true)
    expect(path.endsWith('unsafe_.txt')).toBe(true)
    await expect(readFile(path, 'utf8')).resolves.toBe('hello')
    expect(started.chunkSize).toBe(MAX_LOCAL_ATTACHMENT_CHUNK_BYTES)
  })

  test('returns the same committed path when an attachment finish response is retried', async () => {
    const root = await temporaryDirectory()
    const store = new LocalAttachmentStore(root)
    const started = await store.begin('retry.txt', 1)
    await store.append(started.uploadId, 0, 'YQ==')

    const firstPath = await store.finish(started.uploadId)
    const retriedPath = await store.finish(started.uploadId)

    expect(retriedPath).toBe(firstPath)
    await expect(readFile(retriedPath, 'utf8')).resolves.toBe('a')
  })

  test('shares an in-flight finish across concurrent retries', async () => {
    const root = await temporaryDirectory()
    const store = new LocalAttachmentStore(root)
    const started = await store.begin('concurrent.txt', 1)
    await store.append(started.uploadId, 0, 'YQ==')

    const [firstPath, retriedPath] = await Promise.all([
      store.finish(started.uploadId),
      store.finish(started.uploadId),
    ])

    expect(retriedPath).toBe(firstPath)
    await expect(readFile(firstPath, 'utf8')).resolves.toBe('a')
  })

  test('reuses a client upload id and ignores a replayed append chunk', async () => {
    const root = await temporaryDirectory()
    const store = new LocalAttachmentStore(root)
    const uploadId = '00000000-0000-4000-8000-000000000001'
    const appendId = '00000000-0000-4000-8000-000000000002'

    const [first, retried] = await Promise.all([
      store.begin('retry.bin', 1, uploadId),
      store.begin('retry.bin', 1, uploadId),
    ])
    expect(retried).toEqual(first)
    await expect(store.begin('different.bin', 1, uploadId)).rejects.toThrow(
      'Attachment upload id was reused for a different file'
    )

    const [firstOffset, retriedOffset] = await Promise.all([
      store.append(uploadId, 0, 'YQ==', appendId),
      store.append(uploadId, 0, 'YQ==', appendId),
    ])
    expect([firstOffset, retriedOffset]).toEqual([1, 1])
    expect(await store.append(uploadId, 0, 'YQ==', appendId)).toBe(1)
    await expect(store.append(uploadId, 0, 'Yg==', appendId)).rejects.toThrow(
      'Attachment append retry does not match the original chunk'
    )

    const path = await store.finish(uploadId)
    await expect(readFile(path, 'utf8')).resolves.toBe('a')
  })

  test('rejects offsets, oversized chunks and incomplete uploads', async () => {
    const root = await temporaryDirectory()
    const store = new LocalAttachmentStore(root)
    const started = await store.begin('file.bin', MAX_LOCAL_ATTACHMENT_CHUNK_BYTES + 1)

    await expect(store.append(started.uploadId, 1, 'YQ==')).rejects.toThrow(
      'Attachment chunk offset is invalid'
    )
    await expect(
      store.append(
        started.uploadId,
        0,
        Buffer.alloc(MAX_LOCAL_ATTACHMENT_CHUNK_BYTES + 1).toString('base64')
      )
    ).rejects.toThrow('Attachment chunk size is invalid')
    await store.append(started.uploadId, 0, 'YQ==')
    await expect(store.finish(started.uploadId)).rejects.toThrow('Attachment upload is incomplete')
    await store.abort(started.uploadId)
    await expect(store.finish(started.uploadId)).rejects.toThrow('Attachment upload was not found')
  })

  test('writes a full negotiated chunk and a final byte', async () => {
    const store = new LocalAttachmentStore(await temporaryDirectory())
    const size = MAX_LOCAL_ATTACHMENT_CHUNK_BYTES + 1
    const started = await store.begin('large.bin', size)
    const data = Buffer.alloc(started.chunkSize, 42)

    const offset = await store.append(started.uploadId, 0, data.toString('base64'))
    await expect(store.append(started.uploadId, offset, 'YQ==')).resolves.toBe(size)
    const path = await store.finish(started.uploadId)
    const saved = await readFile(path)
    expect(saved.length).toBe(size)
    expect(saved.subarray(0, offset).equals(data)).toBe(true)
    expect(saved.at(-1)).toBe(97)
  })

  test('rejects invalid declared sizes and malformed base64', async () => {
    const root = await temporaryDirectory()
    const store = new LocalAttachmentStore(root)

    await expect(store.begin('empty.txt', 0)).rejects.toThrow('Attachment size is invalid')
    const started = await store.begin('file.txt', 1)
    await expect(store.append(started.uploadId, 0, '%%%')).rejects.toThrow(
      'Attachment chunk is not valid base64'
    )
  })
})
