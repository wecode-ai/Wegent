import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readDroppedFiles } from './droppedFiles'
import { getNativeFilePath } from './nativeFilePaths'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile: mocks.read }))

describe('native picker files', () => {
  beforeEach(() => {
    mocks.read.mockReset()
  })

  test.each(['/Users/alice/Downloads/report.xlsx', 'C:\\Users\\alice\\Downloads\\report.xlsx'])(
    'retains the source path and readable contents for %s',
    async path => {
      mocks.read.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const [file] = await readDroppedFiles([path])

      expect(getNativeFilePath(file)).toBe(path)
      expect(file.name).toBe('report.xlsx')
      expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3])
    }
  )

  test('reports a source read failure instead of creating an empty attachment', async () => {
    mocks.read.mockRejectedValue(new Error('File unavailable'))

    await expect(readDroppedFiles(['/Users/alice/missing.xlsx'])).rejects.toThrow(
      'File unavailable'
    )
  })
})
