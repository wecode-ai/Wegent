import { describe, expect, test, vi } from 'vitest'
import { decodeDesktopControlImage } from './desktop-control-image'

describe('desktop image decoding', () => {
  test('waits for decoding and reports the decoded image rather than its DOM presence', async () => {
    const image = document.createElement('img')
    image.src = 'blob:http://localhost/image'
    let finishDecode!: () => void
    const decode = vi.fn(() => new Promise<void>(resolve => (finishDecode = resolve)))
    image.decode = decode
    const settled = vi.fn()
    const result = decodeDesktopControlImage(image).then(settled)
    await Promise.resolve()
    expect(decode).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()

    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 2 },
      naturalHeight: { value: 2 },
    })
    finishDecode()
    await result
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      src: image.src,
      complete: true,
      naturalWidth: 2,
      naturalHeight: 2,
    })
  })

  test('rejects a broken image even when it has a blob URL', async () => {
    const image = document.createElement('img')
    image.src = 'blob:http://localhost/broken-image'
    const failure = new DOMException('The source image cannot be decoded', 'EncodingError')
    image.decode = vi.fn().mockRejectedValue(failure)
    await expect(decodeDesktopControlImage(image)).rejects.toBe(failure)
  })

  test('rejects a non-image element', async () => {
    await expect(decodeDesktopControlImage(document.createElement('div'))).rejects.toThrow(
      'requires an image element'
    )
  })
})
