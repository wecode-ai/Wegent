import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalIconButtonTooltip } from './GlobalIconButtonTooltip'

afterEach(() => vi.useRealTimers())

describe('Global icon button tooltips', () => {
  it('keeps the button tooltip hidden when focus arrives during receipt hover', async () => {
    vi.useFakeTimers()
    render(
      <>
        <button aria-label="Assignee">
          <span data-testid="name">Alice</span>
          <span data-tooltip-trigger data-testid="receipt">
            ✓
          </span>
        </button>
        <GlobalIconButtonTooltip />
      </>
    )
    fireEvent.pointerOver(screen.getByTestId('receipt'))
    fireEvent.focusIn(screen.getByRole('button'))
    await act(async () => vi.advanceTimersByTimeAsync(700))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.pointerOut(screen.getByTestId('receipt'), {
      relatedTarget: screen.getByTestId('name'),
    })
    fireEvent.pointerOver(screen.getByTestId('name'))
    await act(async () => vi.advanceTimersByTimeAsync(700))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Assignee')
  })
  it('shows the button label when no explicit tooltip owns the hovered target', async () => {
    vi.useFakeTimers()
    render(
      <>
        <button aria-label="Assignee">
          <span data-testid="name">Alice</span>
        </button>
        <GlobalIconButtonTooltip />
      </>
    )
    fireEvent.pointerOver(screen.getByTestId('name'))
    await act(async () => vi.advanceTimersByTimeAsync(700))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Assignee')
  })

  it('dismisses the button tooltip when hovering a nested explicit receipt tooltip', async () => {
    vi.useFakeTimers()
    render(
      <>
        <button aria-label="Assignee">
          <span data-testid="name">Alice</span>
          <span data-tooltip-trigger>
            <span data-testid="receipt">✓</span>
          </span>
        </button>
        <GlobalIconButtonTooltip />
      </>
    )
    fireEvent.pointerOver(screen.getByTestId('name'))
    await act(async () => vi.advanceTimersByTimeAsync(700))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Assignee')
    fireEvent.pointerOver(screen.getByTestId('receipt'))
    await act(async () => vi.advanceTimersByTimeAsync(700))
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
})
