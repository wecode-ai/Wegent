import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { HoverCard } from './hover-card'

describe('HoverCard', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('opens after the hover delay and stays open while the pointer is over the card', async () => {
    vi.useFakeTimers()
    render(
      <HoverCard
        testId="hover-card"
        interactive
        content={<div data-testid="hover-card-scroll-area">Progress details</div>}
      >
        <button type="button">
          Current task
          <span data-testid="hover-card-anchor-scroll-area">Live activity</span>
        </button>
      </HoverCard>
    )

    const trigger = screen.getByRole('button', { name: /Current task/ })
    fireEvent.mouseEnter(trigger)
    await act(async () => vi.advanceTimersByTime(449))
    expect(screen.queryByTestId('hover-card')).not.toBeInTheDocument()

    await act(async () => vi.advanceTimersByTime(1))
    const card = screen.getByTestId('hover-card')
    expect(card).toHaveTextContent('Progress details')

    fireEvent.scroll(screen.getByTestId('hover-card-anchor-scroll-area'))
    expect(card).toBeInTheDocument()

    fireEvent.mouseLeave(trigger)
    fireEvent.mouseEnter(card)
    fireEvent.scroll(screen.getByTestId('hover-card-scroll-area'))
    await act(async () => vi.advanceTimersByTime(120))
    expect(card).toBeInTheDocument()

    fireEvent.scroll(document.body)
    expect(screen.queryByTestId('hover-card')).not.toBeInTheDocument()
  })

  test('opens on focus and closes on Escape', () => {
    render(
      <HoverCard
        testId="focus-hover-card"
        openOnFocus
        content={<div>Keyboard progress details</div>}
      >
        <button type="button">Current task</button>
      </HoverCard>
    )

    fireEvent.focus(screen.getByText('Current task'))
    expect(screen.getByTestId('focus-hover-card')).toHaveTextContent('Keyboard progress details')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('focus-hover-card')).not.toBeInTheDocument()
  })

  test('positions the card to the left when the right side has less space', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const isCard = this.dataset.testid === 'positioned-hover-card'
      return {
        x: isCard ? 530 : 900,
        y: 100,
        width: isCard ? 360 : 100,
        height: isCard ? 220 : 40,
        top: 100,
        right: isCard ? 890 : 1000,
        bottom: isCard ? 320 : 140,
        left: isCard ? 530 : 900,
        toJSON: () => undefined,
      }
    })
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)

    render(
      <HoverCard
        testId="positioned-hover-card"
        estimatedWidth={360}
        content={<div>Progress details</div>}
      >
        <div>Current task</div>
      </HoverCard>
    )

    fireEvent.mouseEnter(screen.getByText('Current task'))
    await act(async () => vi.advanceTimersByTime(450))

    expect(screen.getByTestId('positioned-hover-card')).toHaveStyle({ left: '530px', top: '100px' })
  })

  test('measures the rendered card and moves it above the bottom viewport edge', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const isCard = this.dataset.testid === 'bottom-hover-card'
      return {
        x: isCard ? 530 : 900,
        y: isCard ? 700 : 680,
        width: isCard ? 360 : 100,
        height: isCard ? 340 : 40,
        top: isCard ? 700 : 680,
        right: isCard ? 890 : 1000,
        bottom: isCard ? 1040 : 720,
        left: isCard ? 530 : 900,
        toJSON: () => undefined,
      }
    })
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)

    render(
      <HoverCard
        testId="bottom-hover-card"
        estimatedWidth={360}
        estimatedHeight={220}
        content={<div>Progress details</div>}
      >
        <div>Current task</div>
      </HoverCard>
    )

    fireEvent.mouseEnter(screen.getByText('Current task'))
    await act(async () => vi.advanceTimersByTime(450))

    expect(screen.getByTestId('bottom-hover-card')).toHaveStyle({
      left: '530px',
      top: '380px',
    })
  })
})
