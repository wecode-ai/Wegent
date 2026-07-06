import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { BufferedChatInput } from './BufferedChatInput'

function renderBufferedChatInput(props?: {
  value?: string
  onChange?: (value: string) => void
  onSubmit?: (valueOverride?: string) => void
}) {
  const onChange = props?.onChange ?? vi.fn()
  const onSubmit = props?.onSubmit ?? vi.fn()

  render(
    <BufferedChatInput
      value={props?.value ?? ''}
      onChange={onChange}
      onSubmit={onSubmit}
      disabled={false}
    />
  )

  return { onChange, onSubmit }
}

describe('BufferedChatInput', () => {
  test('keeps typing local until submit', () => {
    const { onChange, onSubmit } = renderBufferedChatInput()
    const input = screen.getByTestId('chat-message-input')

    fireEvent.change(input, { target: { value: 'hello' } })

    expect(input).toHaveValue('hello')
    expect(onChange).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
    expect(onSubmit).toHaveBeenCalledWith('hello')
    expect(input).toHaveValue('')
  })

  test('syncs external value changes into the draft', () => {
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

    expect(screen.getByTestId('chat-message-input')).toHaveValue('queued message')
  })
})
