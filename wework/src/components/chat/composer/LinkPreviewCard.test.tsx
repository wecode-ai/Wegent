import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { LinkPreviewCard } from './LinkPreviewCard'
import { openExternalUrl } from '@/lib/external-links'

const PREVIEW = {
  url: 'https://github.com/wecode-ai/Wegent/actions',
  domain: 'github.com',
  displayUrl: 'github.com/wecode-ai/Wegent/actions',
  iconUrl: 'https://github.com/favicon.ico',
}

vi.mock('@/lib/external-links', () => ({
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}))

describe('LinkPreviewCard', () => {
  test('renders the card and opens the link', () => {
    render(
      <LinkPreviewCard
        preview={PREVIEW}
        linkText={PREVIEW.displayUrl}
        onRemove={vi.fn()}
        onChangeLinkText={vi.fn()}
        onChangeUrl={vi.fn()}
      />
    )

    expect(screen.getByTestId('link-preview-card')).toBeInTheDocument()
    expect(screen.getByTestId('link-preview-text')).toHaveTextContent(PREVIEW.displayUrl)
    expect(screen.getByTestId('link-preview-url')).toHaveTextContent(PREVIEW.url)

    fireEvent.click(screen.getByTestId('link-preview-open-link'))
    expect(openExternalUrl).toHaveBeenCalledWith(PREVIEW.url)
  })

  test('removes the preview', () => {
    const onRemove = vi.fn()
    render(
      <LinkPreviewCard
        preview={PREVIEW}
        linkText={PREVIEW.displayUrl}
        onRemove={onRemove}
        onChangeLinkText={vi.fn()}
        onChangeUrl={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('link-preview-remove'))
    expect(onRemove).toHaveBeenCalled()
  })

  test('edits the link text', () => {
    const onChangeLinkText = vi.fn()
    render(
      <LinkPreviewCard
        preview={PREVIEW}
        linkText={PREVIEW.displayUrl}
        onRemove={vi.fn()}
        onChangeLinkText={onChangeLinkText}
        onChangeUrl={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('link-preview-edit-text'))
    const input = screen.getByTestId('link-preview-text-input')
    fireEvent.change(input, { target: { value: 'My link' } })
    fireEvent.blur(input)
    expect(onChangeLinkText).toHaveBeenCalledWith('My link')
  })

  test('edits the link URL', () => {
    const onChangeUrl = vi.fn()
    render(
      <LinkPreviewCard
        preview={PREVIEW}
        linkText={PREVIEW.displayUrl}
        onRemove={vi.fn()}
        onChangeLinkText={vi.fn()}
        onChangeUrl={onChangeUrl}
      />
    )

    fireEvent.click(screen.getByTestId('link-preview-edit-url'))
    const input = screen.getByTestId('link-preview-url-input')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChangeUrl).toHaveBeenCalledWith('https://example.com')
  })
})
