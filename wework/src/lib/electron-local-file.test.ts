import { beforeEach, expect, test, vi } from 'vitest'
import { readElectronLocalFile } from './electron-local-file'

const mocks = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => mocks.invokeDesktopHost(...args),
}))

beforeEach(() => {
  mocks.invokeDesktopHost.mockReset()
})

test('reads a local file in chunks while enforcing its declared size', async () => {
  mocks.invokeDesktopHost
    .mockResolvedValueOnce({ chunkBase64: btoa('abc'), bytesRead: 3, eof: false, size: 6 })
    .mockResolvedValueOnce({ chunkBase64: btoa('def'), bytesRead: 3, eof: true, size: 6 })

  const bytes = await readElectronLocalFile('/tmp/plugin.zip', { expectedSize: 6, maxBytes: 10 })

  expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode('abcdef')))
  expect(mocks.invokeDesktopHost).toHaveBeenCalledTimes(2)
})

test('rejects a file before allocation when it exceeds the caller limit', async () => {
  mocks.invokeDesktopHost.mockResolvedValueOnce({
    chunkBase64: '',
    bytesRead: 0,
    eof: true,
    size: 51 * 1024 * 1024,
  })

  await expect(
    readElectronLocalFile('/tmp/plugin.zip', { maxBytes: 50 * 1024 * 1024 })
  ).rejects.toThrow('exceeds the allowed size')
})

test('rejects a file whose size changes between chunks', async () => {
  mocks.invokeDesktopHost
    .mockResolvedValueOnce({ chunkBase64: btoa('abc'), bytesRead: 3, eof: false, size: 6 })
    .mockResolvedValueOnce({ chunkBase64: btoa('def'), bytesRead: 3, eof: true, size: 7 })

  await expect(readElectronLocalFile('/tmp/plugin.zip')).rejects.toThrow(
    'size changed while it was being read'
  )
})

test('rejects a chunk that crosses the declared file boundary', async () => {
  mocks.invokeDesktopHost.mockResolvedValueOnce({
    chunkBase64: btoa('abcd'),
    bytesRead: 4,
    eof: true,
    size: 3,
  })

  await expect(readElectronLocalFile('/tmp/plugin.zip')).rejects.toThrow('invalid local file chunk')
})
