import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { BufferedChatInput } from './BufferedChatInput'

describe('BufferedChatInput', () => {
  test('syncs external value changes into the draft', async () => {
    const { rerender } = render(
      <BufferedChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} />
    )

    rerender(
      <BufferedChatInput
        value="queued message"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        disabled={false}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('chat-message-input')).toHaveValue('queued message')
    })
  })
})
