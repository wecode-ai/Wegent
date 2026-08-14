import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { GENERIC_LINK_ICON_SRC, resolveFavicon } from '@/lib/favicon-resolver'
import { GITHUB_ICON } from '@/lib/link-preview'
import { ComposerLinkChip } from './ComposerLinkChip'

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

const GENERIC_URL = 'https://example.com/page'

describe('ComposerLinkChip', () => {
  beforeEach(() => {
    resolveImageOnLoad = false
    vi.mocked(resolveFavicon).mockReset()
    vi.mocked(resolveFavicon).mockResolvedValue(undefined)
    vi.stubGlobal('Image', MockImage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('renders the generic link icon for a generic URL', () => {
    const { container } = render(
      <ComposerLinkChip payload={{ url: GENERIC_URL, label: 'example.com/page' }} />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(GENERIC_LINK_ICON_SRC)
    expect(screen.getByText('example.com/page')).toBeInTheDocument()
  })

  test('shows the site placeholder favicon when it loads', async () => {
    resolveImageOnLoad = true
    const { container } = render(
      <ComposerLinkChip payload={{ url: GENERIC_URL, label: 'example.com/page' }} />
    )
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://example.com/favicon.ico'
      )
    })
  })

  test('falls back to a generic link icon when a site icon fails to load', () => {
    const { container } = render(
      <ComposerLinkChip payload={{ url: 'wegent-sites-project://prj_01', label: 'prj_01' }} />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    fireEvent.error(img!)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(GENERIC_LINK_ICON_SRC)
  })

  test('upgrades to the resolved favicon when the backend returns one', async () => {
    resolveImageOnLoad = true
    vi.mocked(resolveFavicon).mockResolvedValue('https://example.com/real-icon.png')
    const { container } = render(
      <ComposerLinkChip payload={{ url: GENERIC_URL, label: 'example.com/page' }} />
    )
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://example.com/real-icon.png'
      )
    })
  })

  test('keeps the bundled GitHub icon and never calls the resolver for github.com URLs', () => {
    const { container } = render(
      <ComposerLinkChip
        payload={{ url: 'https://github.com/wecode-ai/Wegent', label: 'wecode-ai/Wegent' }}
      />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(GITHUB_ICON)
    expect(resolveFavicon).not.toHaveBeenCalled()
  })
})
