import { expect, test } from 'vitest'
import { createDesktopControlFile } from './file-fixture'

test('creates a file from the supplied base64 bytes', async () => {
  const file = createDesktopControlFile({
    filename: 'test.txt',
    mimeType: 'text/plain',
    value: 'YQ==',
  })

  expect(file.name).toBe('test.txt')
  expect(file.type).toBe('text/plain')
  expect(await file.text()).toBe('a')
})

test('creates a real large pathless file without a large control-message payload', async () => {
  const size = 100 * 1024 * 1024 + 1
  const file = createDesktopControlFile({
    filename: 'generated.bin',
    fileSize: size,
    value: 'YQ==',
  })

  expect(file.size).toBe(size)
  expect(new Uint8Array(await file.slice(0, 2).arrayBuffer())).toEqual(new Uint8Array([97, 0]))
  expect(new Uint8Array(await file.slice(-1).arrayBuffer())).toEqual(new Uint8Array([0]))
})

test.each([-1, 0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
  'rejects the invalid fixture size %s',
  fileSize => {
    expect(() =>
      createDesktopControlFile({ filename: 'test.bin', value: 'YQ==', fileSize })
    ).toThrow('File fixture size must be a safe integer at least as large as its content')
  }
)
