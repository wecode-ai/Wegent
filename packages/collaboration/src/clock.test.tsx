// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useClock, useDeadlineExpired } from './clock'
import { useRequestUserInputDeadline } from './conversation/useRequestUserInputDeadline'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function Clock({ active = true, until }: { active?: boolean; until?: number }) {
  return <span>{useClock(active, { until })}</span>
}

test('shares one timer, refreshes on focus and stops after the final consumer leaves', () => {
  act(() =>
    root.render(
      <>
        <Clock />
        <Clock />
      </>
    )
  )
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1000))
  expect(container.textContent).toBe('1100011000')
  act(() => {
    vi.setSystemTime(20_000)
    window.dispatchEvent(new Event('focus'))
  })
  expect(container.textContent).toBe('2000020000')
  act(() => root.render(<Clock />))
  expect(vi.getTimerCount()).toBe(1)
  act(() => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
})

test('inactive consumers allocate no timer and receive current time when activated', () => {
  act(() => root.render(<Clock active={false} />))
  expect(vi.getTimerCount()).toBe(0)
  act(() => {
    vi.setSystemTime(30_000)
    root.render(<Clock />)
  })
  expect(container.textContent).toBe('30000')
})

test('deadline subscriptions stop ticking on expiration and reset when a new deadline arrives', () => {
  function Deadline({ deadline }: { deadline: number }) {
    const state = useRequestUserInputDeadline({
      expiresAtUnixMs: deadline,
    } as Parameters<typeof useRequestUserInputDeadline>[0])
    return <span>{state.expired ? 'expired' : state.remainingTime}</span>
  }
  act(() => root.render(<Deadline deadline={12_000} />))
  expect(container.textContent).toBe('0:02')
  act(() => vi.advanceTimersByTime(2000))
  expect(container.textContent).toBe('expired')
  expect(vi.getTimerCount()).toBe(0)
  act(() => {
    vi.setSystemTime(50_000)
    root.render(<Deadline deadline={52_000} />)
  })
  expect(container.textContent).toBe('0:02')
  expect(vi.getTimerCount()).toBe(1)
})

test('minute consumers do not rerender for second ticks and share a single timer', () => {
  let minuteRenders = 0
  function Minute() {
    minuteRenders++
    return <span data-testid="minute">{useClock(true, { resolutionMs: 60_000 })}</span>
  }
  function Second() {
    return <span>{useClock(true)}</span>
  }
  act(() =>
    root.render(
      <>
        <Minute />
        <Second />
      </>
    )
  )
  const initialRenders = minuteRenders
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(59_999))
  expect(minuteRenders).toBe(initialRenders)
  expect(container.querySelector('[data-testid="minute"]')?.textContent).toBe('10000')
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelector('[data-testid="minute"]')?.textContent).toBe('70000')
  act(() =>
    root.render(
      <>
        <Minute />
      </>
    )
  )
  expect(vi.getTimerCount()).toBe(1)
  const afterSecondsLeave = minuteRenders
  act(() => vi.advanceTimersByTime(1000))
  expect(minuteRenders).toBe(afterSecondsLeave)
})

test('expiration readers wait for the exact deadline without intermediate renders', () => {
  const rendered = vi.fn()
  function Deadline({ value }: { value?: number }) {
    const expired = useDeadlineExpired(value)
    rendered(expired)
    return <span>{String(expired)}</span>
  }
  act(() => root.render(<Deadline value={11_250} />))
  const initialRenders = rendered.mock.calls.length
  act(() => vi.advanceTimersByTime(1249))
  expect(rendered).toHaveBeenCalledTimes(initialRenders)
  expect(container.textContent).toBe('false')
  act(() => vi.advanceTimersByTime(1))
  expect(container.textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(0)
  act(() => root.render(<Deadline value={12_000} />))
  expect(container.textContent).toBe('false')
  act(() => root.render(<Deadline />))
  expect(vi.getTimerCount()).toBe(0)
})

test('expiration readers recheck resumed clocks and detach on unmount', () => {
  function Deadline() {
    return <span>{String(useDeadlineExpired(20_000))}</span>
  }
  act(() => root.render(<Deadline />))
  act(() => {
    vi.setSystemTime(30_000)
    window.dispatchEvent(new Event('focus'))
  })
  expect(container.textContent).toBe('true')
  expect(vi.getTimerCount()).toBe(0)
  act(() => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
})

test('captures the final time when deactivated between ticks without keeping a timer', () => {
  act(() => root.render(<Clock />))
  act(() => vi.setSystemTime(10_550))
  act(() => root.render(<Clock active={false} />))
  expect(container.textContent).toBe('10550')
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.setSystemTime(11_550))
  act(() => root.render(<Clock active={false} />))
  expect(container.textContent).toBe('10550')
})

test('keeps different consumer periods exact even when the subscriptions start at different times', () => {
  function Phase() {
    return <span data-testid="phase">{useClock(true, { resolutionMs: 1200 })}</span>
  }
  function Clocks({ phase }: { phase: boolean }) {
    return (
      <>
        <Clock />
        {phase && <Phase />}
      </>
    )
  }
  act(() => root.render(<Clocks phase={false} />))
  act(() => vi.advanceTimersByTime(100))
  act(() => root.render(<Clocks phase />))
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1199))
  expect(container.querySelector('[data-testid="phase"]')?.textContent).toBe('10100')
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelector('[data-testid="phase"]')?.textContent).toBe('11300')
  expect(container.querySelector('span')?.textContent).toBe('11000')
  act(() => vi.advanceTimersByTime(700))
  expect(container.querySelector('span')?.textContent).toBe('12000')
  expect(vi.getTimerCount()).toBe(1)
})
