import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { QuickPhraseMenu } from './QuickPhraseMenu'

const appPreferenceMocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/hooks/useQuickPhrases', () => ({
  useQuickPhrases: () => [
    { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
    { id: 'plan', title: '制定计划', content: '制定实施计划', mode: 'plan' },
    {
      id: 'stash-images',
      title: '两张图片',
      content: '',
      mode: 'normal',
      attachmentPaths: ['/tmp/one.png', '/tmp/two.jpg'],
    },
  ],
}))

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}))

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))

vi.mock('@/tauri/appPreferences', () => ({
  getAppPreferences: appPreferenceMocks.get,
  updateAppPreferences: appPreferenceMocks.update,
}))

describe('QuickPhraseMenu', () => {
  test('selects a phrase with the mouse', () => {
    const onSelect = vi.fn()
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    fireEvent.click(screen.getByTestId('quick-phrase-option-plan'))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan' }))
    expect(screen.queryByTestId('quick-phrase-menu')).not.toBeInTheDocument()
  })

  test('filters and selects a phrase with the keyboard', () => {
    const onSelect = vi.fn()
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    const search = screen.getByTestId('quick-phrase-search-input')
    fireEvent.change(search, { target: { value: '计划' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan' }))
  })

  test('renders attachment stashes in a horizontal tray with hover preview', () => {
    render(<QuickPhraseMenu onSelect={vi.fn()} />)
    fireEvent.click(screen.getByTestId('quick-phrase-button'))

    const stash = screen.getByTestId('quick-phrase-stash-stash-images')
    const tray = screen.getByTestId('quick-phrase-stash-tray')
    expect(tray).toContainElement(stash)
    expect(
      tray.compareDocumentPosition(screen.getByTestId('quick-phrase-option-summary')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(stash.querySelectorAll('img')).toHaveLength(2)

    fireEvent.pointerEnter(stash)
    expect(screen.getByTestId('quick-phrase-stash-preview')).toHaveTextContent('两张图片')
  })

  test('deletes a stash without selecting it', async () => {
    const onSelect = vi.fn()
    appPreferenceMocks.get.mockResolvedValue({
      quickPhrases: [
        { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        {
          id: 'stash-images',
          title: '两张图片',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/one.png', '/tmp/two.jpg'],
        },
      ],
    })
    appPreferenceMocks.update.mockResolvedValue(undefined)
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    fireEvent.click(screen.getByTestId('quick-phrase-stash-delete-stash-images'))

    await waitFor(() =>
      expect(appPreferenceMocks.update).toHaveBeenCalledWith({
        quickPhrases: [
          { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
        ],
      })
    )
    expect(onSelect).not.toHaveBeenCalled()
  })
})
