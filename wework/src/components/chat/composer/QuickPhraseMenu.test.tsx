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

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))

vi.mock('@/desktop/appPreferences', () => ({
  getAppPreferences: appPreferenceMocks.get,
  updateAppPreferences: appPreferenceMocks.update,
}))

describe('QuickPhraseMenu', () => {
  test('filters and selects a phrase with the keyboard', () => {
    const onSelect = vi.fn()
    render(<QuickPhraseMenu onSelect={onSelect} />)

    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    const search = screen.getByTestId('quick-phrase-search-input')
    fireEvent.change(search, { target: { value: '计划' } })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan' }))
  })

  test('keeps the stash visible on deletion failure and clears the error after retry', async () => {
    appPreferenceMocks.get.mockResolvedValue({
      quickPhrases: [
        {
          id: 'stash-images',
          title: '两张图片',
          content: '',
          mode: 'normal',
          attachmentPaths: ['/tmp/one.png'],
        },
      ],
    })
    appPreferenceMocks.update
      .mockRejectedValueOnce(new Error('Cannot delete stash'))
      .mockResolvedValue(undefined)
    render(<QuickPhraseMenu onSelect={vi.fn()} />)
    fireEvent.click(screen.getByTestId('quick-phrase-button'))
    fireEvent.click(screen.getByTestId('quick-phrase-stash-delete-stash-images'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cannot delete stash'))
    expect(screen.getByTestId('quick-phrase-stash-stash-images')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('quick-phrase-stash-delete-stash-images'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
