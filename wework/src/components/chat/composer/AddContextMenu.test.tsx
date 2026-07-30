import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  test('moves focus into the portal and restores it after Escape', async () => {
    render(<AddContextMenu disabled={false} onFileSelect={vi.fn()} />)

    const trigger = screen.getByTestId('add-context-button')
    fireEvent.click(trigger)

    await waitFor(() => expect(screen.getByTestId('attach-files-button')).toHaveFocus())
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByTestId('add-context-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
