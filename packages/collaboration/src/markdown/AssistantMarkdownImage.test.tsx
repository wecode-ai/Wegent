// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantMarkdownImage } from './AssistantMarkdownImage'
import {
  MarkdownServicesProvider,
  browserMarkdownServices,
  type MarkdownServices,
} from './MarkdownServices'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
async function render(src: string, services: Partial<MarkdownServices> = {}) {
  await act(() =>
    root.render(
      <MarkdownServicesProvider value={{ ...browserMarkdownServices, ...services }}>
        <AssistantMarkdownImage src={src} alt="Resource" />
      </MarkdownServicesProvider>
    )
  )
}

describe('platform Markdown image resolution', () => {
  it('lets the owner resolve relative images without fetching them from the browser origin', async () => {
    const resolveImageUrl = vi.fn().mockResolvedValue('http://127.0.0.1:5000/session/image.png')
    await render('../images/test.png', { resolveImageUrl })
    expect(resolveImageUrl).toHaveBeenCalledWith('../images/test.png')
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'http://127.0.0.1:5000/session/image.png'
    )
  })
  it('preserves direct desktop image URLs when no platform resolver is supplied', async () => {
    await render('https://example.test/image.png')
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.test/image.png'
    )
  })
  it('shows the existing image error when the owner cannot load a resource', async () => {
    await render('missing.png', {
      resolveImageUrl: vi.fn().mockRejectedValue(new Error('Device offline')),
    })
    expect(
      container.querySelector('[data-testid="assistant-markdown-image-error"]')?.textContent
    ).toBe('Resource')
    expect(container.querySelector('img')).toBeNull()
  })
  it('does not replace a newer image with a late result from the old document', async () => {
    let complete!: (url: string) => void
    const resolveImageUrl = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            complete = resolve
          })
      )
      .mockResolvedValue('http://127.0.0.1:5000/new.png')
    await render('old.png', { resolveImageUrl })
    await render('new.png', { resolveImageUrl })
    await act(() => complete('http://127.0.0.1:5000/old.png'))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'http://127.0.0.1:5000/new.png'
    )
  })
})
