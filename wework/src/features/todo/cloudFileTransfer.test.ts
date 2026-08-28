import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileFromAccessUrl } from './cloudFileTransfer'

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
})
