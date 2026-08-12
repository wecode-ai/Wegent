import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GENERIC_LINK_ICON_SRC, resolveFavicon } from '@/lib/favicon-resolver'
import { GITHUB_ICON } from '@/lib/link-preview'
import { ComposerLinkChip } from './ComposerLinkChip'

vi.mock('@/lib/favicon-resolver', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/favicon-resolver')>('@/lib/favicon-resolver')
  return { ...actual, resolveFavicon: vi.fn(async () => undefined) }
})

const GENERIC_URL = 'https://example.com/page'

describe('ComposerLinkChip', () => {
  beforeEach(() => {
    vi.mocked(resolveFavicon).mockReset()
    vi.mocked(resolveFavicon).mockResolvedValue(undefined)
  })

  test('renders the default favicon for a generic URL', () => {
    const { container } = render(
      <ComposerLinkChip payload={{ url: GENERIC_URL, label: 'example.com/page' }} />
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/favicon.ico'
    )
    expect(screen.getByText('example.com/page')).toBeInTheDocument()
  })

  test('falls back to a generic link icon when the favicon fails to load', () => {
    const { container } = render(
      <ComposerLinkChip payload={{ url: GENERIC_URL, label: 'example.com/page' }} />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    fireEvent.error(img!)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(GENERIC_LINK_ICON_SRC)
  })

  test('upgrades to the resolved favicon when the backend returns one', async () => {
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
