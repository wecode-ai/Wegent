import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileFromAccessUrl, saveBlobToDownloads } from './cloudFileTransfer'

describe('cloudFileTransfer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads remote object storage files through fetch', async () => {
    const blob = new Blob(['snapshot'])
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn(async () => blob),
    } as unknown as Response)

    await expect(readFileFromAccessUrl('https://objects.example/snapshot.md')).resolves.toEqual(
      blob
    )
    expect(fetchMock).toHaveBeenCalledWith('https://objects.example/snapshot.md')
  })

  it('downloads a blob through a temporary browser URL', async () => {
    vi.useFakeTimers()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:snapshot')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)

    await expect(saveBlobToDownloads(new Blob(['snapshot']), 'snapshot.md')).resolves.toBe(
      'snapshot.md'
    )
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:snapshot')
    vi.useRealTimers()
  })
})
