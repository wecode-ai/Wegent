// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useMediaQuery } from './media-query'

let container: HTMLDivElement
let root: Root | undefined
const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      const state = queries.get(query) ?? {
        matches: false,
        listeners: new Set<() => void>(),
      }
      queries.set(query, state)
      return {
        get matches() {
          return state.matches
        },
        addEventListener: (_type: string, listener: () => void) => state.listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          state.listeners.delete(listener),
      }
    })
  )
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container.remove()
  queries.clear()
  vi.unstubAllGlobals()
})
function Probe({ query }: { query: string }) {
  return <span>{String(useMediaQuery(query))}</span>
}

test('tracks the current query and releases subscriptions on query changes and unmount', () => {
  root = createRoot(container)
  act(() => root!.render(<Probe query="mobile" />))
  expect(container.textContent).toBe('false')
  act(() => {
    const state = queries.get('mobile')!
    state.matches = true
    state.listeners.forEach(listener => listener())
  })
  expect(container.textContent).toBe('true')
  act(() => root!.render(<Probe query="reduced-motion" />))
  expect(queries.get('mobile')!.listeners.size).toBe(0)
  expect(container.textContent).toBe('false')
  act(() => root!.unmount())
  root = undefined
  expect(queries.get('reduced-motion')!.listeners.size).toBe(0)
})

test('hydrates the server default before reading the current media state', async () => {
  queries.set('mobile', { matches: true, listeners: new Set() })
  container.innerHTML = renderToString(<Probe query="mobile" />)
  expect(container.textContent).toBe('false')
  const onRecoverableError = vi.fn()
  await act(async () => {
    root = hydrateRoot(container, <Probe query="mobile" />, {
      onRecoverableError,
    })
  })
  expect(container.textContent).toBe('true')
  expect(onRecoverableError).not.toHaveBeenCalled()
})
