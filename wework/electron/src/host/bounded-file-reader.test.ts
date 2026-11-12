import { describe, expect, it, vi } from 'vitest'
import { readBoundedFile } from './bounded-file-reader.js'

function growingFile(contents: string) {
  const source = Buffer.from(contents)
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = source.copy(buffer, offset, position, position + length)
      return { bytesRead, buffer }
    }),
  }
}

describe('bounded file reading', () => {
  it('accepts exactly the limit and checks authority after every asynchronous read', async () => {
    const file = growingFile('12345')
    const authorize = vi.fn()
    expect((await readBoundedFile(file as never, 5, authorize)).toString()).toBe('12345')
    expect(authorize).toHaveBeenCalledTimes(file.read.mock.calls.length)
  })

  it('rejects actual bytes over the budget without reading the whole growing file', async () => {
    const file = growingFile('1234567890')
    await expect(readBoundedFile(file as never, 5)).rejects.toThrow('allowed size')
    expect(file.read.mock.calls[0]?.[2]).toBe(6)
  })

  it('stops reading immediately when the owner is revoked', async () => {
    const file = growingFile('12345')
    await expect(
      readBoundedFile(file as never, 5, () => {
        throw new Error('revoked')
      })
    ).rejects.toThrow('revoked')
    expect(file.read).toHaveBeenCalledOnce()
  })

  it('awaits asynchronous authorization before accepting bytes or reading again', async () => {
    const file = growingFile('12345')
    const authorize = vi.fn(async () => {
      throw new Error('asynchronously revoked')
    })
    await expect(readBoundedFile(file as never, 5, authorize)).rejects.toThrow(
      'asynchronously revoked'
    )
    expect(file.read).toHaveBeenCalledOnce()
  })
})
