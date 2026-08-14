import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resolveFavicon } from '@/lib/favicon-resolver'
import { applyLinkIcon, type ComposerLinkPayload } from './composerLinks'

vi.mock('@/lib/favicon-resolver', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/favicon-resolver')>('@/lib/favicon-resolver')
  return { ...actual, resolveFavicon: vi.fn(async () => undefined) }
})

let resolveImageOnLoad = false
class MockImage {
  onload: (() => void) | null = null
  set src(value: string) {
    // jsdom never loads images; only resolve the probe when the test opts in.
    if (resolveImageOnLoad) this.onload?.()
  }
}

const webLink = (url: string): ComposerLinkPayload => ({ url, label: url, provider: 'web' })

function mountIcon(): HTMLImageElement {
  const icon = document.createElement('img')
  document.body.appendChild(icon)
  return icon
}

beforeEach(() => {
  resolveImageOnLoad = false
  vi.mocked(resolveFavicon).mockReset()
  vi.mocked(resolveFavicon).mockResolvedValue(undefined)
  vi.stubGlobal('Image', MockImage)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('applyLinkIcon', () => {
  test('applies the backend favicon when the URL is unchanged', async () => {
    resolveImageOnLoad = true
    vi.mocked(resolveFavicon).mockResolvedValue('https://cdn.example.com/icon.png')
    const icon = mountIcon()

    applyLinkIcon(icon, webLink('https://example.com/page'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(icon.src).toBe('https://cdn.example.com/icon.png')
  })

  test('ignores a stale favicon resolution after the link URL changes', async () => {
    resolveImageOnLoad = true
    let resolveA: (value: string | undefined) => void
    const promiseA = new Promise<string | undefined>(resolve => {
      resolveA = resolve
    })
    vi.mocked(resolveFavicon)
      .mockReturnValueOnce(promiseA)
      .mockResolvedValueOnce('https://cdn.example.com/icon-b.png')
    const icon = mountIcon()

    applyLinkIcon(icon, webLink('https://example.com/a'))
    applyLinkIcon(icon, webLink('https://example.com/b'))
    resolveA!('https://cdn.example.com/icon-a.png')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(resolveFavicon).toHaveBeenCalledWith('https://example.com/b')
    expect(icon.src).toBe('https://cdn.example.com/icon-b.png')
  })
})
