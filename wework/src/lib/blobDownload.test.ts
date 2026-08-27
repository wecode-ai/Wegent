import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveBlobToDownloads } from './blobDownload'

describe('saveBlobToDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('downloads a blob through a temporary mounted link', async () => {
    vi.useFakeTimers()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:snapshot')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const appendChild = vi.spyOn(document.body, 'appendChild')

    await expect(saveBlobToDownloads(new Blob(['snapshot']), 'snapshot.md')).resolves.toBe(
      'snapshot.md'
    )

    const anchor = appendChild.mock.calls[0]?.[0]
    expect(anchor).toBeInstanceOf(HTMLAnchorElement)
    expect(anchor).toMatchObject({
      href: 'blob:snapshot',
      download: 'snapshot.md',
      isConnected: false,
    })
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:snapshot')
  })
})
