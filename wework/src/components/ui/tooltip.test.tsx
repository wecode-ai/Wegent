import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Tooltip } from './tooltip'

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.advanceTimersByTime(301)
    vi.useRealTimers()
  })

  test('shows the label on hover after the delay and hides on pointer leave', () => {
    render(
      <Tooltip label="添加上下文" testId="composer-tooltip">
        <button type="button">trigger</button>
      </Tooltip>
    )
    const wrapper = screen.getByRole('button').parentElement as HTMLElement
    expect(screen.queryByTestId('composer-tooltip')).not.toBeInTheDocument()

    fireEvent.pointerEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(699)
    })
    expect(screen.queryByTestId('composer-tooltip')).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    const tooltip = screen.getByTestId('composer-tooltip')
    expect(tooltip).toHaveClass('opacity-100')
    expect(tooltip).toHaveTextContent('添加上下文')

    fireEvent.pointerLeave(wrapper)
    expect(screen.queryByTestId('composer-tooltip')).not.toBeInTheDocument()
  })

  test('hides on Escape while focused', () => {
    render(
      <Tooltip label="插件" testId="composer-tooltip">
        <button type="button">trigger</button>
      </Tooltip>
    )
    const wrapper = screen.getByRole('button').parentElement as HTMLElement

    fireEvent.focus(wrapper)
    act(() => {
      vi.advanceTimersByTime(700)
    })
    const tooltip = screen.getByTestId('composer-tooltip')
    expect(tooltip).toHaveClass('opacity-100')

    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(screen.queryByTestId('composer-tooltip')).not.toBeInTheDocument()
  })

  test('renders through a portal so clipped controls can show the tooltip', () => {
    const { container } = render(
      <div className="overflow-hidden">
        <Tooltip label="新建项目空间" testId="project-space-tooltip">
          <button type="button">trigger</button>
        </Tooltip>
      </div>
    )
    const wrapper = screen.getByRole('button').parentElement as HTMLElement

    fireEvent.pointerEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(700)
    })

    const tooltip = screen.getByTestId('project-space-tooltip')
    expect(document.body).toContainElement(tooltip)
    expect(container).not.toContainElement(tooltip)
  })

  test('shows the next tooltip immediately during the warm handoff window', () => {
    render(
      <>
        <Tooltip label="第一个提示" testId="first-tooltip">
          <button type="button">first</button>
        </Tooltip>
        <Tooltip label="第二个提示" testId="second-tooltip">
          <button type="button">second</button>
        </Tooltip>
      </>
    )
    const firstWrapper = screen.getByRole('button', { name: 'first' }).parentElement as HTMLElement
    const secondWrapper = screen.getByRole('button', {
      name: 'second',
    }).parentElement as HTMLElement

    fireEvent.pointerEnter(firstWrapper)
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(screen.getByTestId('first-tooltip')).toBeInTheDocument()

    fireEvent.pointerLeave(firstWrapper)
    fireEvent.pointerEnter(secondWrapper)
    act(() => {
      vi.advanceTimersByTime(0)
    })

    expect(screen.getByTestId('second-tooltip')).toBeInTheDocument()
  })

  test('wraps long unbroken labels within the maximum width', () => {
    render(
      <Tooltip label={'a'.repeat(400)} testId="long-tooltip">
        <button type="button">trigger</button>
      </Tooltip>
    )
    const wrapper = screen.getByRole('button').parentElement as HTMLElement

    fireEvent.pointerEnter(wrapper)
    act(() => {
      vi.advanceTimersByTime(700)
    })

    expect(screen.getByTestId('long-tooltip')).toHaveClass('whitespace-normal', 'break-words')
    expect(screen.getByTestId('long-tooltip')).not.toHaveClass('whitespace-nowrap')
  })
})
