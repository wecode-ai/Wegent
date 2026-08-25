import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { MAX_LOCAL_FILE_CHUNK_BYTES, readLocalFileChunk } from './local-file-reader.js'

describe('readLocalFileChunk', () => {
  test('reads a file in independently bounded chunks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-local-file-reader-'))
    const path = join(directory, 'image.png')
    await writeFile(path, Buffer.from('preview-data'))

    await expect(readLocalFileChunk(path, 0, 7)).resolves.toEqual({
      chunkBase64: Buffer.from('preview').toString('base64'),
      bytesRead: 7,
      eof: false,
      size: 12,
    })
    await expect(readLocalFileChunk(path, 7, 7)).resolves.toEqual({
      chunkBase64: Buffer.from('-data').toString('base64'),
      bytesRead: 5,
      eof: true,
      size: 12,
    })
  })

  test('rejects invalid offsets and oversized frames', async () => {
    await expect(readLocalFileChunk('/unused', -1, 1)).rejects.toThrow(
      'offset must be a non-negative safe integer'
    )
    await expect(readLocalFileChunk('/unused', 0, MAX_LOCAL_FILE_CHUNK_BYTES + 1)).rejects.toThrow(
      'chunk length must be between'
    )
  })
})
