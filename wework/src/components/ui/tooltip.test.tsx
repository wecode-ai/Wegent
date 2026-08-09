import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Tooltip } from './tooltip'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('shows the label on hover after the delay and hides on pointer leave', () => {
    render(
      <Tooltip label="添加上下文" testId="composer-tooltip">
        <button type="button">trigger</button>
      </Tooltip>
    )
    const wrapper = screen.getByRole('button').parentElement as HTMLElement
    const tooltip = screen.getByTestId('composer-tooltip')
    expect(tooltip).toHaveClass('opacity-0')

    fireEvent.pointerEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(699)
    })
    expect(tooltip).toHaveClass('opacity-0')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(tooltip).toHaveClass('opacity-100')
    expect(tooltip).toHaveTextContent('添加上下文')

    fireEvent.pointerLeave(wrapper)
    expect(tooltip).toHaveClass('opacity-0')
  })

  test('hides on Escape while focused', () => {
    render(
      <Tooltip label="插件" testId="composer-tooltip">
        <button type="button">trigger</button>
      </Tooltip>
    )
    const wrapper = screen.getByRole('button').parentElement as HTMLElement
    const tooltip = screen.getByTestId('composer-tooltip')

    fireEvent.focus(wrapper)
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(tooltip).toHaveClass('opacity-100')

    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(tooltip).toHaveClass('opacity-0')
  })
})
