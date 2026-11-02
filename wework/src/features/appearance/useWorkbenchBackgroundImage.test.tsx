import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useWorkbenchBackgroundImage } from './useWorkbenchBackgroundImage'
import type { WorkbenchBackgroundImage } from './backgroundImage'

const { loadWorkbenchBackgroundImage } = vi.hoisted(() => ({
  loadWorkbenchBackgroundImage: vi.fn(),
}))

vi.mock('./backgroundImage', () => ({ loadWorkbenchBackgroundImage }))

interface DeferredImage {
  promise: Promise<WorkbenchBackgroundImage | null>
  resolve: (image: WorkbenchBackgroundImage | null) => void
  reject: (error: unknown) => void
}

function deferredImage(): DeferredImage {
  let resolve!: (image: WorkbenchBackgroundImage | null) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<WorkbenchBackgroundImage | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function image(url: string) {
  const release = vi.fn()
  return { image: { url, release }, release }
}

function renderBackgroundImage() {
  return renderHook(({ path }: { path: string | null }) => useWorkbenchBackgroundImage(path), {
    initialProps: { path: '/backgrounds/a.png' },
  })
}

describe('useWorkbenchBackgroundImage', () => {
  beforeEach(() => {
    loadWorkbenchBackgroundImage.mockReset()
  })

  test('reloads the same path after it is cleared instead of returning the revoked URL', async () => {
    const first = image('blob:a-old')
    const second = image('blob:a-new')
    loadWorkbenchBackgroundImage
      .mockResolvedValueOnce(first.image)
      .mockResolvedValueOnce(second.image)

    const { result, rerender } = renderBackgroundImage()
    await waitFor(() => expect(result.current.url).toBe('blob:a-old'))

    rerender({ path: null })

    expect(result.current.url).toBeNull()
    expect(first.release).toHaveBeenCalledTimes(1)

    rerender({ path: '/backgrounds/a.png' })

    expect(result.current.url).toBeNull()

    await waitFor(() => expect(result.current.url).toBe('blob:a-new'))
    expect(result.current.failed).toBe(false)
    expect(loadWorkbenchBackgroundImage).toHaveBeenCalledTimes(2)
  })

  test('recovers when a path that failed earlier loads successfully after another path', async () => {
    const second = image('blob:b')
    const third = image('blob:a-retry')
    loadWorkbenchBackgroundImage
      .mockRejectedValueOnce(new Error('missing file'))
      .mockResolvedValueOnce(second.image)
      .mockResolvedValueOnce(third.image)

    const { result, rerender } = renderBackgroundImage()
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.url).toBeNull()

    rerender({ path: '/backgrounds/b.png' })
    await waitFor(() => expect(result.current.url).toBe('blob:b'))

    rerender({ path: '/backgrounds/a.png' })
    await waitFor(() => expect(result.current.url).toBe('blob:a-retry'))

    expect(result.current.failed).toBe(false)
  })

  test('ignores a stale image request that resolves after the path changed', async () => {
    const slowA = deferredImage()
    const second = image('blob:b')
    loadWorkbenchBackgroundImage
      .mockReturnValueOnce(slowA.promise)
      .mockResolvedValueOnce(second.image)

    const { result, rerender } = renderBackgroundImage()
    rerender({ path: '/backgrounds/b.png' })
    await waitFor(() => expect(result.current.url).toBe('blob:b'))

    const stale = image('blob:a-late')
    slowA.resolve(stale.image)
    await waitFor(() => expect(stale.release).toHaveBeenCalledTimes(1))

    expect(result.current.url).toBe('blob:b')
    expect(result.current.failed).toBe(false)
  })

  test('reports a decode failure until the image request for that path succeeds again', async () => {
    const first = image('blob:a')
    const second = image('blob:a-retry')
    loadWorkbenchBackgroundImage
      .mockResolvedValueOnce(first.image)
      .mockResolvedValueOnce(second.image)

    const { result, rerender } = renderBackgroundImage()
    await waitFor(() => expect(result.current.url).toBe('blob:a'))

    act(() => result.current.reportLoadError())

    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.url).toBeNull()

    rerender({ path: null })
    rerender({ path: '/backgrounds/a.png' })

    await waitFor(() => expect(result.current.url).toBe('blob:a-retry'))
    expect(result.current.failed).toBe(false)
  })
})
