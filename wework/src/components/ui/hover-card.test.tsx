import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createPortal } from 'react-dom'
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

  test('keeps an interactive card open while clicking portal content', () => {
    const onClick = vi.fn()
    render(
      <HoverCard
        testId="interactive-hover-card"
        interactive
        openOnFocus
        content={
          <button type="button" onClick={onClick}>
            Send reply
          </button>
        }
      >
        <button type="button">Current task</button>
      </HoverCard>
    )

    fireEvent.focus(screen.getByText('Current task'))
    fireEvent.pointerDown(screen.getByText('Send reply'))
    fireEvent.click(screen.getByText('Send reply'))

    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByTestId('interactive-hover-card')).toBeInTheDocument()
  })

  test('closes an interactive card when its anchor is clicked', () => {
    render(
      <HoverCard
        testId="interactive-anchor-hover-card"
        interactive
        openOnFocus
        content={<button type="button">Popup action</button>}
      >
        <button type="button">Anchor action</button>
      </HoverCard>
    )

    const anchor = screen.getByText('Anchor action')
    fireEvent.focus(anchor)
    expect(screen.getByTestId('interactive-anchor-hover-card')).toBeInTheDocument()

    fireEvent.pointerDown(anchor)
    expect(screen.queryByTestId('interactive-anchor-hover-card')).not.toBeInTheDocument()
  })

  test('closes a hovered card when its focused anchor hands off to another anchor', async () => {
    vi.useFakeTimers()
    render(
      <>
        <HoverCard testId="first-hover-card" interactive content={<div>First task details</div>}>
          <button type="button">First task</button>
        </HoverCard>
        <HoverCard testId="second-hover-card" interactive content={<div>Second task details</div>}>
          <button type="button">Second task</button>
        </HoverCard>
      </>
    )

    const firstAnchor = screen.getByRole('button', { name: 'First task' })
    const secondAnchor = screen.getByRole('button', { name: 'Second task' })
    fireEvent.focus(firstAnchor)
    fireEvent.mouseEnter(firstAnchor)
    await act(async () => vi.advanceTimersByTime(450))
    expect(screen.getByTestId('first-hover-card')).toBeInTheDocument()

    fireEvent.mouseLeave(firstAnchor)
    fireEvent.mouseEnter(secondAnchor)
    fireEvent.pointerMove(secondAnchor)
    await act(async () => vi.advanceTimersByTime(120))
    expect(screen.queryByTestId('first-hover-card')).not.toBeInTheDocument()

    await act(async () => vi.advanceTimersByTime(330))
    expect(screen.getByTestId('second-hover-card')).toBeInTheDocument()
    expect(screen.queryAllByRole('dialog')).toHaveLength(1)
  })

  test('stays open while focus moves between descendants of the same hovered anchor', async () => {
    vi.useFakeTimers()
    render(
      <HoverCard
        testId="multi-focus-anchor-hover-card"
        interactive
        content={<div>Task details</div>}
      >
        <div>
          <button type="button">Open task</button>
          <button type="button">Pin task</button>
        </div>
      </HoverCard>
    )

    const firstAction = screen.getByRole('button', { name: 'Open task' })
    const secondAction = screen.getByRole('button', { name: 'Pin task' })
    fireEvent.mouseEnter(firstAction)
    await act(async () => vi.advanceTimersByTime(450))
    expect(screen.getByTestId('multi-focus-anchor-hover-card')).toBeInTheDocument()

    fireEvent.focus(firstAction)
    fireEvent.blur(firstAction, { relatedTarget: secondAction })
    fireEvent.focus(secondAction)
    await act(async () => vi.advanceTimersByTime(120))
    expect(screen.getByTestId('multi-focus-anchor-hover-card')).toBeInTheDocument()

    fireEvent.mouseLeave(secondAction)
    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(120))
    expect(screen.queryByTestId('multi-focus-anchor-hover-card')).not.toBeInTheDocument()
  })

  test('keeps an interactive card open while using a nested portal menu', async () => {
    vi.useFakeTimers()
    const onClick = vi.fn()
    const NestedPortalAction = () =>
      createPortal(
        <button type="button" data-testid="nested-portal-action" onClick={onClick}>
          Apply quick phrase
        </button>,
        document.body
      )

    render(
      <HoverCard
        testId="nested-portal-hover-card"
        interactive
        openOnFocus
        content={
          <div>
            Composer
            <NestedPortalAction />
          </div>
        }
      >
        <button type="button">Current task</button>
      </HoverCard>
    )

    fireEvent.focus(screen.getByText('Current task'))
    const card = screen.getByTestId('nested-portal-hover-card')
    const action = screen.getByTestId('nested-portal-action')

    fireEvent.mouseLeave(card)
    fireEvent.pointerMove(action)
    fireEvent.pointerDown(action)
    fireEvent.click(action)
    await act(async () => vi.advanceTimersByTime(120))

    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByTestId('nested-portal-hover-card')).toBeInTheDocument()
  })

  test('keeps an interactive card open while its input retains focus', async () => {
    vi.useFakeTimers()
    render(
      <HoverCard
        testId="focused-input-hover-card"
        interactive
        openOnFocus
        content={<input data-testid="hover-card-input" aria-label="Reply" />}
      >
        <button type="button">Current task</button>
      </HoverCard>
    )

    fireEvent.focus(screen.getByText('Current task'))
    const card = screen.getByTestId('focused-input-hover-card')
    const input = screen.getByTestId('hover-card-input')

    fireEvent.focus(input)
    fireEvent.mouseLeave(card)
    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(240))
    expect(screen.getByTestId('focused-input-hover-card')).toBeInTheDocument()

    fireEvent.blur(input, { relatedTarget: document.body })
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(120)
    })
    expect(screen.queryByTestId('focused-input-hover-card')).not.toBeInTheDocument()
  })

  test('pins an interactive card after focusing its input and closes it explicitly', async () => {
    vi.useFakeTimers()
    render(
      <HoverCard
        testId="pinned-hover-card"
        interactive
        openOnFocus
        pinOnInteraction
        closeLabel="Close popup"
        content={<input data-testid="pinned-hover-card-input" aria-label="Reply" />}
      >
        <button type="button">Current task</button>
      </HoverCard>
    )

    fireEvent.focus(screen.getByText('Current task'))
    const card = screen.getByTestId('pinned-hover-card')
    const input = screen.getByTestId('pinned-hover-card-input')
    expect(screen.queryByTestId('pinned-hover-card-close')).not.toBeInTheDocument()

    fireEvent.focus(input)
    expect(screen.getByTestId('pinned-hover-card-close')).toHaveAttribute(
      'aria-label',
      'Close popup'
    )

    fireEvent.blur(input, { relatedTarget: document.body })
    fireEvent.mouseLeave(card)
    fireEvent.pointerMove(document.body)
    await act(async () => {
      await Promise.resolve()
      vi.advanceTimersByTime(240)
    })
    expect(screen.getByTestId('pinned-hover-card')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('pinned-hover-card-close'))
    expect(screen.queryByTestId('pinned-hover-card')).not.toBeInTheDocument()
  })

  test('pins only interactions inside the configured region', () => {
    render(
      <HoverCard
        testId="scoped-pinned-hover-card"
        interactive
        openOnFocus
        pinOnInteraction
        pinOnInteractionSelector="[data-pin-region]"
        content={
          <div>
            <button type="button">Load older messages</button>
            <div data-pin-region>
              <input aria-label="Reply" />
            </div>
          </div>
        }
      >
        <button type="button">Current task</button>
      </HoverCard>
    )

    fireEvent.focus(screen.getByText('Current task'))
    fireEvent.pointerDown(screen.getByText('Load older messages'))
    fireEvent.focus(screen.getByText('Load older messages'))
    expect(screen.queryByTestId('scoped-pinned-hover-card-close')).not.toBeInTheDocument()

    fireEvent.pointerDown(screen.getByLabelText('Reply'))
    fireEvent.focus(screen.getByLabelText('Reply'))
    expect(screen.getByTestId('scoped-pinned-hover-card-close')).toBeInTheDocument()
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

  test('calibrates once when the rendered size changes with its position', async () => {
    vi.useFakeTimers()
    let cardMeasurements = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const isCard = this.dataset.testid === 'stable-hover-card'
      if (!isCard) {
        return {
          x: 100,
          y: 500,
          width: 100,
          height: 40,
          top: 500,
          right: 200,
          bottom: 540,
          left: 100,
          toJSON: () => undefined,
        }
      }

      cardMeasurements += 1
      const top = Number.parseFloat(this.style.top)
      const height = top === 500 ? 340 : 220
      return {
        x: 210,
        y: top,
        width: 360,
        height,
        top,
        right: 570,
        bottom: top + height,
        left: 210,
        toJSON: () => undefined,
      }
    })
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)

    render(
      <HoverCard
        testId="stable-hover-card"
        estimatedWidth={360}
        estimatedHeight={220}
        content={<div>Position-sensitive details</div>}
      >
        <div>Current task</div>
      </HoverCard>
    )

    fireEvent.mouseEnter(screen.getByText('Current task'))
    await act(async () => vi.advanceTimersByTime(450))

    expect(screen.getByTestId('stable-hover-card')).toHaveStyle({ left: '210px', top: '200px' })
    expect(cardMeasurements).toBe(1)
  })
})
