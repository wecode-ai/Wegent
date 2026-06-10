import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { TextInputDialog } from './TextInputDialog'

describe('TextInputDialog', () => {
  test('focuses the input and keeps actions touch friendly', () => {
    render(
      <TextInputDialog
        open
        title="重命名项目"
        label="项目名称"
        initialValue="hello"
        confirmLabel="保存"
        cancelLabel="取消"
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByTestId('rename-project-input')).toHaveFocus()
    expect(screen.getByTestId('confirm-rename-project-button')).toHaveClass('h-11')
    expect(screen.getByTestId('rename-project-input-cancel-button')).toHaveClass('h-11')
    expect(screen.getByTestId('rename-project-input-overlay').parentElement).toBe(
      document.body,
    )
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })

  test('closes when Escape is pressed', () => {
    const onClose = vi.fn()

    render(
      <TextInputDialog
        open
        title="重命名项目"
        label="项目名称"
        initialValue="hello"
        confirmLabel="保存"
        cancelLabel="取消"
        inputTestId="rename-project-input"
        confirmTestId="confirm-rename-project-button"
        onClose={onClose}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByTestId('rename-project-input')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
