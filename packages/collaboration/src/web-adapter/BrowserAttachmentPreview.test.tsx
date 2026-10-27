// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { BrowserAttachmentPreview } from './BrowserAttachmentPreview'

const translate = createCollaborationTranslator('zh-CN')
let container: HTMLDivElement
let root: Root
let mounted: boolean

function render(read: (id: string) => Promise<Blob>, onClose = vi.fn(), filename = '截屏.png') {
  return act(async () => {
    root.render(
      <BrowserAttachmentPreview
        attachmentId="attachment-1"
        filename={filename}
        read={read}
        translate={translate}
        onClose={onClose}
      />
    )
  })
}

function element<T extends HTMLElement>(testId: string): T {
  const target = document.querySelector<T>(`[data-testid="${testId}"]`)
  expect(target).not.toBeNull()
  return target!
}

async function unmount() {
  await act(async () => root.unmount())
  mounted = false
}

describe('BrowserAttachmentPreview', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true
      },
    })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false
      },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn().mockReturnValue('blob:attachment-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    mounted = true
  })

  afterEach(async () => {
    if (mounted) await unmount()
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the fetched image, waits for load and releases the URL on close', async () => {
    const blob = new Blob(['image'], { type: 'image/png' })
    const read = vi.fn(async () => blob)
    const close = vi.fn()
    await render(read, close)

    expect(read).toHaveBeenCalledWith('attachment-1')
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob)
    expect(element<HTMLDialogElement>('browser-attachment-preview-dialog').open).toBe(true)
    const image = element<HTMLImageElement>('browser-attachment-preview-image')
    expect(image.src).toBe('blob:attachment-preview')
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(document.querySelector('[role="status"]')).toBeNull()

    await act(async () => element<HTMLButtonElement>('browser-attachment-preview-close').click())
    expect(close).toHaveBeenCalledOnce()
    await unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-preview')
  })

  it.each(['text/html', 'text/plain'])(
    'renders %s as text without executing embedded HTML',
    async contentType => {
      const content = '<script>window.previewExecuted = true</script><h1>Unsafe HTML</h1>'
      const blob = Object.assign(new Blob([content], { type: contentType }), {
        text: async () => content,
      })
      await render(
        vi.fn(async () => blob),
        vi.fn(),
        'report.html'
      )

      expect(element('browser-attachment-preview-text').textContent).toBe(content)
      expect(document.querySelector('script, iframe, h1')).toBeNull()
      const download = element<HTMLAnchorElement>('browser-attachment-preview-download')
      expect(download.href).toBe('blob:attachment-preview')
      expect(download.download).toBe('report.html')
      expect(document.querySelector('[role="status"]')).toBeNull()
    }
  )

  it.each(['application/pdf', 'application/zip'])(
    'shows %s metadata with a named native download',
    async contentType => {
      await render(vi.fn(async () => new Blob(['binary'], { type: contentType })))

      expect(element('browser-attachment-preview-binary').textContent).toBe('截屏.png · 6 B')
      expect(element<HTMLAnchorElement>('browser-attachment-preview-download').download).toBe(
        '截屏.png'
      )
      expect(document.querySelector('iframe')).toBeNull()
    }
  )

  it('resets failed and loaded state when the reader changes and releases the old URL', async () => {
    await render(vi.fn(async () => Promise.reject(new Error('Access denied'))))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('预览失败')
    expect(URL.createObjectURL).not.toHaveBeenCalled()

    await render(vi.fn(async () => new Blob(['first'], { type: 'image/png' })))
    expect(document.querySelector('[role="alert"]')).toBeNull()
    const image = element<HTMLImageElement>('browser-attachment-preview-image')
    await act(async () => image.dispatchEvent(new Event('load')))
    expect(document.querySelector('[role="status"]')).toBeNull()

    let resolveRead!: (blob: Blob) => void
    await render(vi.fn(() => new Promise<Blob>(resolve => (resolveRead = resolve))))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-preview')
    expect(document.querySelector('[data-testid="browser-attachment-preview-image"]')).toBeNull()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    await act(async () => resolveRead(new Blob(['next'], { type: 'image/png' })))
    expect(element('browser-attachment-preview-image')).toBeDefined()
  })

  it('shows failed image decoding and releases its URL when dismissed', async () => {
    await render(vi.fn(async () => new Blob(['broken'], { type: 'image/png' })))
    await act(async () =>
      element('browser-attachment-preview-image').dispatchEvent(new Event('error'))
    )

    expect(document.querySelector('[role="alert"]')?.textContent).toBe('预览失败')
    expect(document.querySelector('[data-testid="browser-attachment-preview-image"]')).toBeNull()
    await unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:attachment-preview')
  })

  it('discards an in-flight response after the preview is unmounted', async () => {
    let resolveRead!: (blob: Blob) => void
    await render(vi.fn(() => new Promise<Blob>(resolve => (resolveRead = resolve))))
    await unmount()
    await act(async () => resolveRead(new Blob(['late'], { type: 'image/png' })))

    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="browser-attachment-preview-dialog"]')).toBeNull()
  })

  it('handles native cancel without letting Escape dismiss the underlying Issue', async () => {
    const close = vi.fn()
    const cancelled = new Event('cancel', { bubbles: true, cancelable: true })
    await render(
      vi.fn(async () => new Blob(['image'], { type: 'image/png' })),
      close
    )

    await act(async () => element('browser-attachment-preview-dialog').dispatchEvent(cancelled))

    expect(cancelled.defaultPrevented).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })
})
