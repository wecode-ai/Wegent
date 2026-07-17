import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { QuickPhraseMenu } from './QuickPhraseMenu'

vi.mock('@/hooks/useQuickPhrases', () => ({
  useQuickPhrases: () => [
    { id: 'summary', title: '总结进展', content: '总结当前进展', mode: 'normal' },
    { id: 'plan', title: '制定计划', content: '制定实施计划', mode: 'plan' },
  ],
}))

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))

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
})
