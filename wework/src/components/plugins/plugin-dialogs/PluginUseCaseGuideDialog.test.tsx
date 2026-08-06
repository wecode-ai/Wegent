import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { PluginUseCaseGuideDialog } from './PluginUseCaseGuideDialog'

describe('PluginUseCaseGuideDialog', () => {
  test('adds the selected preference to the generated task', async () => {
    const onConfirm = vi.fn()

    render(
      <PluginUseCaseGuideDialog
        pluginName="Sites"
        title="Create a daily sudoku game with a leaderboard"
        generatedPrompt="Use Sites to create a daily Sudoku game."
        confirmation={{
          question: 'How should players appear?',
          defaultOptionId: 'nickname',
          options: [
            {
              id: 'nickname',
              label: 'Show nicknames',
              promptValue: 'Show player nicknames on the leaderboard',
            },
            {
              id: 'anonymous',
              label: 'Anonymous ranking',
              promptValue: 'Use anonymous player IDs on the leaderboard',
            },
          ],
        }}
        installed
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    await act(async () => {
      await new Promise(resolve => window.requestAnimationFrame(resolve))
    })
    await userEvent.click(screen.getByTestId('plugin-use-case-option-anonymous'))
    expect(screen.getByTestId('plugin-use-case-draft-input')).toHaveTextContent(
      'Use anonymous player IDs on the leaderboard'
    )
    await userEvent.click(screen.getByTestId('plugin-use-case-context-toggle'))
    await userEvent.type(
      screen.getByTestId('plugin-use-case-context-input'),
      'Keep the first version local-only.'
    )
    await userEvent.click(screen.getByTestId('plugin-use-case-start-button'))

    expect(onConfirm).toHaveBeenCalledWith(
      expect.stringContaining('Use Sites to create a daily Sudoku game.')
    )
    expect(onConfirm).toHaveBeenCalledWith(
      expect.stringContaining('Use anonymous player IDs on the leaderboard')
    )
    expect(onConfirm).toHaveBeenCalledWith(
      expect.stringContaining('Keep the first version local-only.')
    )
  })

  test('makes the goal editable and clearly opts into conversation context', async () => {
    const onConfirm = vi.fn()

    render(
      <PluginUseCaseGuideDialog
        pluginName="Browser"
        title="Check the checkout flow"
        generatedPrompt="Check the checkout flow on localhost."
        confirmation={{
          question: 'How far should it go?',
          defaultOptionId: 'preview',
          options: [
            {
              id: 'preview',
              label: 'Stop before submit',
              promptValue: 'Stop before submitting the order',
            },
          ],
        }}
        hasConversationContext
        installed
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    const user = userEvent.setup()
    const goalInput = screen.getByTestId('plugin-use-case-goal-input') as HTMLTextAreaElement
    await act(async () => {
      await new Promise(resolve => window.requestAnimationFrame(resolve))
    })
    await user.clear(goalInput)
    await user.type(goalInput, 'Verify the cart total and discount code.')
    await user.click(screen.getByTestId('plugin-use-case-context-suggestion'))

    expect(screen.getByTestId('plugin-use-case-draft-input')).toHaveTextContent(
      'Verify the cart total and discount code.'
    )
    expect(screen.getByTestId('plugin-use-case-draft-input')).toHaveTextContent('当前对话')
    expect(screen.queryByTestId('plugin-use-case-context-input')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('plugin-use-case-start-button'))
    expect(onConfirm).toHaveBeenCalledWith(expect.stringContaining('当前对话'))
  })
})
