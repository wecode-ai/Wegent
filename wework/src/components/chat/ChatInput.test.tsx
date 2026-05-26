import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { ChatInput } from './ChatInput'

function ControlledChatInput({
  onSubmit = vi.fn(),
}: {
  onSubmit?: () => void
}) {
  const [value, setValue] = useState('')

  return <ChatInput value={value} onChange={setValue} onSubmit={onSubmit} disabled={false} />
}

describe('ChatInput', () => {
  test('renders the desktop composer sections', () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    expect(screen.getByTestId('chat-message-input')).toHaveAttribute('rows', '2')
    expect(screen.getByTestId('custom-mode-button')).toBeInTheDocument()
    expect(screen.getByTestId('model-selector-button')).toBeInTheDocument()
    expect(screen.getByTestId('project-work-button')).toBeInTheDocument()
  })

  test('opens the desktop model menu', async () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    await userEvent.click(screen.getByTestId('model-selector-button'))

    expect(screen.getByTestId('model-selector-menu')).toBeInTheDocument()
    expect(screen.getByText('智能')).toBeInTheDocument()
    expect(screen.getByText('低')).toBeInTheDocument()
    expect(screen.getByText('中')).toBeInTheDocument()
    expect(screen.getByText('高')).toBeInTheDocument()
    expect(screen.getByText('超高')).toBeInTheDocument()
    expect(screen.getByText('GPT-5.5')).toBeInTheDocument()
    expect(screen.getByText('速度')).toBeInTheDocument()
  })

  test('opens the desktop custom mode menu', async () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    await userEvent.click(screen.getByTestId('custom-mode-button'))

    expect(screen.getByTestId('custom-mode-menu')).toBeInTheDocument()
    expect(screen.getByText('默认权限')).toBeInTheDocument()
    expect(screen.getByText('自动审查')).toBeInTheDocument()
    expect(screen.getByText('完全访问权限')).toBeInTheDocument()
    expect(screen.getByText('自定义 (config.toml)')).toBeInTheDocument()
  })

  test('opens the desktop add context menu', async () => {
    render(
      <ChatInput value="" onChange={vi.fn()} onSubmit={vi.fn()} disabled={false} variant="desktop" />,
    )

    await userEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('add-context-menu')).toBeInTheDocument()
    expect(screen.getByText('添加照片和文件')).toBeInTheDocument()
    expect(screen.getByText('Attach Google Chrome')).toBeInTheDocument()
    expect(screen.getByText('计划模式')).toBeInTheDocument()
    expect(screen.getByText('追求目标')).toBeInTheDocument()
    expect(screen.getByText('插件')).toBeInTheDocument()
  })

  test('submits typed content', async () => {
    const onChange = vi.fn()
    const onSubmit = vi.fn()
    render(<ChatInput value="hello" onChange={onChange} onSubmit={onSubmit} disabled={false} />)

    await userEvent.click(screen.getByTestId('send-message-button'))

    expect(onSubmit).toHaveBeenCalled()
  })

  test('submits with Enter when content is present', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    await userEvent.type(screen.getByTestId('chat-message-input'), 'hello{enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  test('keeps Shift Enter as a newline', async () => {
    const onSubmit = vi.fn()
    render(<ControlledChatInput onSubmit={onSubmit} />)

    const input = screen.getByTestId('chat-message-input')
    await userEvent.type(input, 'hello{shift>}{enter}{/shift}world')

    expect(input).toHaveValue('hello\nworld')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
