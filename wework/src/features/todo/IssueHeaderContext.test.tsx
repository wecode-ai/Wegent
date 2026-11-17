import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { IssueHeaderContext } from '../../../../packages/collaboration/src/issue-detail/IssueHeaderContext'

afterEach(() => vi.unstubAllGlobals())

it('keeps the title and state available while reading discussion, and restores project context at the top', () => {
  let observe!: IntersectionObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observe = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    }
  )
  function Detail({ id, title }: { id: string; title: string }) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const titleRef = useRef<HTMLTextAreaElement>(null)
    return (
      <>
        <IssueHeaderContext
          issueId={id}
          title={title}
          status="进行中"
          scrollRef={scrollRef}
          titleRef={titleRef}
        >
          <span>项目 / {id}</span>
        </IssueHeaderContext>
        <div ref={scrollRef}>
          <textarea ref={titleRef} defaultValue={title} />
        </div>
      </>
    )
  }
  const { rerender, unmount } = render(<Detail id="one" title="检查交付" />)
  const intersect = (bottom: number) =>
    act(() =>
      observe(
        [{ boundingClientRect: { bottom }, rootBounds: { top: 52 } } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    )
  intersect(51)
  expect(screen.getByTestId('issue-header-context')).toHaveTextContent('检查交付进行中')
  rerender(<Detail id="one" title="核对交付" />)
  expect(screen.getByTestId('issue-header-context')).toHaveTextContent('核对交付')
  intersect(92)
  expect(screen.queryByTestId('issue-header-context')).toBeNull()
  expect(screen.getByText('项目 / one')).toBeVisible()
  intersect(51)
  rerender(<Detail id="two" title="另一个事项" />)
  expect(screen.queryByTestId('issue-header-context')).toBeNull()
  expect(screen.getByText('项目 / two')).toBeVisible()
  unmount()
  expect(disconnect).toHaveBeenCalledTimes(2)
})
