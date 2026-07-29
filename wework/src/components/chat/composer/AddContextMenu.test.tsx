import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AddContextMenu } from './AddContextMenu'

describe('AddContextMenu', () => {
  test('renders its menu in a body portal so composer containers cannot clip it', () => {
    render(<AddContextMenu disabled={false} onFileSelect={vi.fn()} />)

    fireEvent.click(screen.getByTestId('add-context-button'))

    expect(screen.getByTestId('add-context-menu').parentElement).toBe(document.body)
  })

  test('keeps portal menu actions interactive', () => {
    const onSetGoal = vi.fn()
    render(<AddContextMenu disabled={false} onFileSelect={vi.fn()} onSetGoal={onSetGoal} />)

    fireEvent.click(screen.getByTestId('add-context-button'))
    fireEvent.click(screen.getByTestId('set-goal-button'))

    expect(onSetGoal).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
  })
})
