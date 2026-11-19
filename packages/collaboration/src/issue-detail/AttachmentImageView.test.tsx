// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AttachmentImageView, type AttachmentImageServices } from './AttachmentImageView'
import { CollaborationTheme } from '../theme'

type Attachment = { id: string; filename: string }
type Image = { url: string; release: () => void }
const first = { id: 'A', filename: 'a.png' },
  second = { id: 'B', filename: 'b.png' },
  third = { id: 'C', filename: 'c.png' }
const gallery = [first, second, third]
let root: Root
let container: HTMLDivElement
let services: AttachmentImageServices<Attachment>
function held() {
  let resolve!: (value: Image) => void
  const promise = new Promise<Image>(done => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  services = {
    identity: attachment => attachment.id,
    load: vi.fn(),
    download: vi.fn(),
    loadImmediately: true,
  }
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(attachment = first) {
  await act(async () =>
    root.render(
      <CollaborationTheme mode="light">
        <AttachmentImageView
          services={services}
          attachment={attachment}
          galleryAttachments={gallery}
          buttonTestId="preview"
          imageTestId="preview-image"
          loadingTestId="loading"
          errorTestId="failed"
          imageClassName=""
          placeholderClassName=""
        />
      </CollaborationTheme>
    )
  )
}
async function click(id: string) {
  await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click())
}

test('releases an image that arrives after its preview is unmounted', async () => {
  const request = held(),
    release = vi.fn()
  vi.mocked(services.load).mockReturnValue(request.promise)
  await render()
  act(() => root.render(null))
  await act(async () => request.resolve({ url: 'blob:late', release }))
  expect(release).toHaveBeenCalledTimes(1)
  expect(container.querySelector('img')).toBeNull()
})

test('switching attachment identity isolates late results and releases both URL owners', async () => {
  const old = held(),
    current = held(),
    releaseOld = vi.fn(),
    releaseCurrent = vi.fn()
  vi.mocked(services.load).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
  await render()
  await render(second)
  await act(async () => current.resolve({ url: 'blob:B', release: releaseCurrent }))
  await act(async () => old.resolve({ url: 'blob:A', release: releaseOld }))
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:B')
  expect(releaseOld).toHaveBeenCalledTimes(1)
  act(() => root.render(null))
  expect(releaseCurrent).toHaveBeenCalledTimes(1)
})

test('the lightbox borrows the preview URL and releases superseded gallery reads independently', async () => {
  const pending = held(),
    releasePreview = vi.fn(),
    releaseOld = vi.fn(),
    releaseCurrent = vi.fn()
  vi.mocked(services.load)
    .mockResolvedValueOnce({ url: 'blob:A', release: releasePreview })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ url: 'blob:C', release: releaseCurrent })
  await render()
  await click('preview')
  expect(services.load).toHaveBeenCalledTimes(1)
  await click('attachment-image-next')
  await click('attachment-image-next')
  await act(async () => pending.resolve({ url: 'blob:B', release: releaseOld }))
  expect(
    document.querySelector('[data-testid="attachment-image-lightbox-image"]')?.getAttribute('src')
  ).toBe('blob:C')
  expect(releaseOld).toHaveBeenCalledTimes(1)
  await click('attachment-image-lightbox-close')
  expect(releaseCurrent).toHaveBeenCalledTimes(1)
  expect(releasePreview).not.toHaveBeenCalled()
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:A')
  act(() => root.render(null))
  expect(releasePreview).toHaveBeenCalledTimes(1)
})

test('lazy loading uses the current attachment metadata when its identity stays unchanged', async () => {
  const callbacks: IntersectionObserverCallback[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback)
      }
      observe() {}
      disconnect() {}
    }
  )
  services.loadImmediately = false
  vi.mocked(services.load).mockResolvedValue({ url: 'blob:current', release: vi.fn() })
  await render()
  const renamed = { ...first, filename: 'renamed.png' }
  await render(renamed)
  expect(services.load).not.toHaveBeenCalled()
  await act(async () =>
    callbacks.at(-1)!(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  )
  expect(services.load).toHaveBeenCalledExactlyOnceWith(renamed)
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:current')
})
