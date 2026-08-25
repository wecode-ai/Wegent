import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
