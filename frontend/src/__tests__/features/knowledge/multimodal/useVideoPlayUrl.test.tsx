import { act, renderHook, waitFor } from '@testing-library/react'
import { useVideoPlayUrl } from '@/features/knowledge/multimodal/components/MultimodalVideoPreview'

jest.mock('@/apis/user', () => ({
  getToken: () => 'test-token',
}))

describe('useVideoPlayUrl', () => {
  beforeEach(() => {
    global.fetch = jest.fn()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('clears the previous document URL when the next request fails', async () => {
    const fetchMock = jest
      .mocked(global.fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://cdn.example.com/video-a.mp4' }),
      } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)

    const { result, rerender } = renderHook(({ documentId }) => useVideoPlayUrl(documentId, true), {
      initialProps: { documentId: 1 },
    })

    await waitFor(() => {
      expect(result.current.playUrl).toBe('https://cdn.example.com/video-a.mp4')
    })

    act(() => rerender({ documentId: 2 }))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
      expect(result.current.playUrl).toBeNull()
      expect(result.current.hasError).toBe(true)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('allows a failed URL request to be retried', async () => {
    const fetchMock = jest
      .mocked(global.fetch)
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: 'https://cdn.example.com/recovered.mp4' }),
      } as Response)

    const { result } = renderHook(() => useVideoPlayUrl(1, true))

    await waitFor(() => expect(result.current.hasError).toBe(true))
    act(() => result.current.retry())

    await waitFor(() => {
      expect(result.current.playUrl).toBe('https://cdn.example.com/recovered.mp4')
      expect(result.current.hasError).toBe(false)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clears media state when disabled', async () => {
    jest.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://cdn.example.com/video.mp4' }),
    } as Response)

    const { result, rerender } = renderHook(({ enabled }) => useVideoPlayUrl(1, enabled), {
      initialProps: { enabled: true },
    })

    await waitFor(() => expect(result.current.playUrl).not.toBeNull())
    act(() => rerender({ enabled: false }))

    expect(result.current.playUrl).toBeNull()
    expect(result.current.isLoading).toBe(false)
  })
})
