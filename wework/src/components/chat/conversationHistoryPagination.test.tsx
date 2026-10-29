import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ConversationTranslationProvider } from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { ConversationHistoryBoundary } from '../../../../packages/collaboration/src/conversation/ConversationHistoryBoundary'

const observers: Array<{
  callback: IntersectionObserverCallback
  options: IntersectionObserverInit
  active: boolean
}> = []
const viewport = document.createElement('div')
Object.defineProperty(viewport, 'clientHeight', { value: 900 })
const scrollRef = { current: viewport }

beforeEach(() => {
  observers.length = 0
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: (typeof observers)[number]
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        this.entry = { callback, options, active: true }
        observers.push(this.entry)
      }
      observe() {}
      disconnect() {
        this.entry.active = false
      }
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

function intersect(visible = true) {
  act(() => {
    for (const observer of [...observers].filter(observer => observer.active)) {
      observer.callback(
        [{ isIntersecting: visible } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    }
  })
}

function boundary(props: Partial<Parameters<typeof ConversationHistoryBoundary>[0]> = {}) {
  return (
    <ConversationTranslationProvider translate={createCollaborationTranslator('en')}>
      <ConversationHistoryBoundary
        boundaryKey="page-1"
        scrollRef={scrollRef}
        suspended={false}
        loading={false}
        controlsTarget={document.body}
        onPrepare={vi.fn()}
        {...props}
      />
    </ConversationTranslationProvider>
  )
}

describe('automatic conversation history pagination', () => {
  test('prefetches one viewport ahead with one request per boundary', async () => {
    let resolve!: () => void
    const onLoad = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    const onPrepare = vi.fn()
    const view = render(boundary({ onLoad, onPrepare }))
    expect(observers[0].options).toMatchObject({ root: viewport, rootMargin: '900px 0px 0px' })
    expect(screen.queryByTestId('load-older-runtime-transcript-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-transcript-history-start')).toHaveClass('h-px')
    intersect(false)
    expect(onLoad).not.toHaveBeenCalled()
    intersect()
    intersect()
    expect(onPrepare).toHaveBeenCalledWith(true)
    expect(onLoad).toHaveBeenCalledOnce()
    view.rerender(boundary({ onLoad, onPrepare, loading: true }))
    await act(async () => resolve())
    expect(screen.queryByTestId('load-older-runtime-transcript-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-transcript-history-start')).toHaveClass('h-px')
    view.rerender(boundary({ onLoad, onPrepare }))
    intersect()
    expect(onLoad).toHaveBeenCalledOnce()
    // A committed earlier page, not a loading flag or a projection render, re-arms prefetch.
    view.rerender(boundary({ onLoad, onPrepare, boundaryKey: 'page-0' }))
    intersect()
    expect(onLoad).toHaveBeenCalledTimes(2)
    await act(async () => resolve())
  })

  test('re-arms after a new page commits before the preceding request settles', async () => {
    let resolve!: () => void
    const onLoad = vi.fn(
      () =>
        new Promise<void>(done => {
          resolve = done
        })
    )
    const view = render(boundary({ onLoad }))
    intersect()
    view.rerender(boundary({ onLoad, boundaryKey: 'earlier-page' }))
    intersect()
    expect(onLoad).toHaveBeenCalledOnce()
    await act(async () => resolve())
    intersect()
    expect(onLoad).toHaveBeenCalledTimes(2)
    await act(async () => resolve())
  })

  test('catches a failed fetch and retries only on explicit action', async () => {
    const onLoad = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined)
    render(boundary({ onLoad }))
    await act(async () => intersect())
    intersect()
    expect(onLoad).toHaveBeenCalledOnce()
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toHaveTextContent('Retry')
    await act(async () =>
      fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    )
    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBeEnabled()
    expect(screen.getByTestId('load-older-runtime-transcript-button')).not.toHaveTextContent(
      'Retry'
    )
  })

  test('retains explicit context loading while search owns the viewport', async () => {
    const onLoad = vi.fn().mockResolvedValue(undefined)
    const onPrepare = vi.fn()
    render(boundary({ onLoad, onPrepare, suspended: true, manual: true }))
    intersect()
    expect(onLoad).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    )
    expect(onLoad).toHaveBeenCalledOnce()
    expect(onPrepare).toHaveBeenCalledWith(false)
  })

  test('recovers if preparing the reading position fails before the request starts', async () => {
    const onLoad = vi.fn().mockResolvedValue(undefined)
    const onPrepare = vi.fn().mockImplementationOnce(() => {
      throw new Error('Detached anchor')
    })
    render(boundary({ onLoad, onPrepare }))
    await act(async () => intersect())
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toHaveTextContent('Retry')
    await act(async () =>
      fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    )
    expect(onLoad).toHaveBeenCalledOnce()
  })

  test('retries a host-reported pagination error without reloading the conversation', async () => {
    const onLoad = vi.fn().mockResolvedValue(undefined)
    const view = render(boundary({ onLoad, failed: true }))
    intersect()
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toHaveTextContent('Retry')
    await act(async () =>
      fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    )
    expect(onLoad).toHaveBeenCalledOnce()
    view.rerender(boundary({ onLoad }))
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBeEnabled()
    intersect()
    expect(onLoad).toHaveBeenCalledOnce()
  })

  test('offers manual recovery without looping when a completed request makes no progress', async () => {
    const onLoad = vi.fn().mockResolvedValue(undefined)
    const onPrepare = vi.fn()
    const view = render(boundary({ onLoad, onPrepare }))
    await act(async () => intersect())
    intersect()
    expect(onLoad).toHaveBeenCalledOnce()
    await act(async () =>
      fireEvent.click(screen.getByTestId('load-older-runtime-transcript-button'))
    )
    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(onPrepare).toHaveBeenLastCalledWith(false)
    view.rerender(boundary({ onLoad, onPrepare, boundaryKey: 'earlier-page' }))
    expect(screen.queryByTestId('load-older-runtime-transcript-button')).not.toBeInTheDocument()
    await act(async () => intersect())
    expect(onLoad).toHaveBeenCalledTimes(3)
    expect(onPrepare).toHaveBeenLastCalledWith(true)
  })

  test('keeps the recovery button and keyboard focus throughout an asynchronous retry', async () => {
    let resolve!: () => void
    const onLoad = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>(done => {
            resolve = done
          })
      )
    const view = render(boundary({ onLoad }))
    await act(async () => intersect())
    const button = screen.getByTestId('load-older-runtime-transcript-button')
    button.focus()
    fireEvent.click(button)
    view.rerender(boundary({ onLoad, loading: true }))
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBe(button)
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button.querySelector('.animate-spin')).toBeInTheDocument()
    fireEvent.click(button)
    expect(onLoad).toHaveBeenCalledTimes(2)
    await act(async () => resolve())
    expect(screen.getByTestId('load-older-runtime-transcript-button')).toBe(button)
    expect(button).toHaveFocus()
    view.rerender(boundary({ onLoad }))
    expect(button).toHaveAttribute('aria-disabled', 'false')
    expect(screen.getByTestId('runtime-transcript-history-start')).toHaveClass('h-px')
  })

  test('ignores queued observer callbacks after suspension or unmount', () => {
    const onLoad = vi.fn()
    const view = render(boundary({ onLoad }))
    const queued = observers[0].callback
    view.rerender(boundary({ onLoad, suspended: true }))
    expect(screen.queryByTestId('load-older-runtime-transcript-button')).not.toBeInTheDocument()
    act(() =>
      queued([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    )
    expect(onLoad).not.toHaveBeenCalled()
    view.rerender(boundary({ onLoad }))
    const nextQueued = observers.at(-1)!.callback
    view.unmount()
    act(() =>
      nextQueued(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    )
    expect(onLoad).not.toHaveBeenCalled()
  })

  test('never loads without a host callback or while host pagination is busy', () => {
    const view = render(boundary())
    intersect()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    const onLoad = vi.fn()
    view.rerender(boundary({ onLoad, loading: true }))
    intersect()
    expect(onLoad).not.toHaveBeenCalled()
  })
})
