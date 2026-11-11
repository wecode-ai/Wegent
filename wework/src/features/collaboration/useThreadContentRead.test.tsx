import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import { useThreadContentRead } from './useThreadContentRead'

const bounds = {
  width: 400,
  height: 300,
  top: 0,
  bottom: 300,
  left: 0,
  right: 400,
  x: 0,
  y: 0,
  toJSON() {},
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const item = {
  id: 'G-1',
  cloud_project_id: 'group',
  content_revision: 4,
  is_unread: true,
} as CollaborationIssue
function Harness(props: Omit<Parameters<typeof useThreadContentRead>[0], 'viewport'>) {
  const viewport = useRef<HTMLDivElement>(null)
  const read = useThreadContentRead({ ...props, viewport })
  return (
    <div ref={viewport} data-testid="content">
      Visible Thread content
      {read.failed && <button onClick={read.retry}>Retry read</button>}
    </div>
  )
}
function fixture() {
  const markRead = vi.fn().mockResolvedValue({ ...item, is_unread: false })
  return { api: { issues: { markRead } } as unknown as SharedWorkspaceApi, markRead }
}
function values(api: SharedWorkspaceApi): ComponentProps<typeof Harness> {
  return {
    api,
    accountScope: 'account',
    groupId: 'group',
    actorId: 0,
    item,
    active: true,
    loaded: true,
    onRead: vi.fn(),
  }
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => vi.restoreAllMocks())

describe('Thread content read confirmation', () => {
  it('confirms only the presented revision with explicit zero activity cursor for canonical actor0', async () => {
    const { api, markRead } = fixture()
    const props = values(api)
    const view = render(<Harness {...props} />)
    await waitFor(() => expect(markRead).toHaveBeenCalledExactlyOnceWith('G-1', 0, 4))
    expect(props.onRead).toHaveBeenCalledOnce()
    view.rerender(<Harness {...props} />)
    fireEvent.scroll(screen.getByTestId('content'))
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(markRead).toHaveBeenCalledOnce()
  })

  it.each([
    { active: false },
    { loaded: false },
    { actorId: undefined },
    { actorId: '' },
    { item: null },
    { item: { ...item, content_revision: undefined } },
    { item: { ...item, content_revision: Number.NaN } },
    { item: { ...item, content_revision: Number.POSITIVE_INFINITY } },
    { item: { ...item, content_revision: -1 } },
    { item: { ...item, cloud_project_id: 'other-group' } },
    { item: { ...item, is_unread: false } },
  ])('does not acknowledge unavailable/unseen content %j', async change => {
    const { api, markRead } = fixture()
    render(<Harness {...values(api)} {...change} />)
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(markRead).not.toHaveBeenCalled()
  })

  it.each(['hidden-document', 'zero-viewport', 'hidden-ancestor'])(
    'waits for actual visibility: %s',
    async mode => {
      const { api, markRead } = fixture()
      if (mode === 'hidden-document')
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
      if (mode === 'zero-viewport')
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
          ...bounds,
          height: 0,
        })
      render(
        <div aria-hidden={mode === 'hidden-ancestor'}>
          <Harness {...values(api)} />
        </div>
      )
      await act(() => new Promise(resolve => requestAnimationFrame(resolve)))
      expect(markRead).not.toHaveBeenCalled()
    }
  )

  it('retains content on failure and explicitly retries the same exact revision', async () => {
    const { api, markRead } = fixture()
    markRead.mockRejectedValueOnce(new Error('offline'))
    const props = values(api)
    render(<Harness {...props} />)
    const retry = await screen.findByRole('button', { name: 'Retry read' })
    expect(screen.getByText('Visible Thread content')).toBeVisible()
    expect(props.onRead).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await waitFor(() => expect(props.onRead).toHaveBeenCalledOnce())
    expect(markRead.mock.calls).toEqual([
      ['G-1', 0, 4],
      ['G-1', 0, 4],
    ])
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it.each(['account', 'api', 'group', 'item', 'revision', 'inactive'])(
    'fences late confirmation after %s changes',
    async change => {
      const { api, markRead } = fixture()
      const pending = deferred<CollaborationIssue>()
      markRead.mockReturnValueOnce(pending.promise)
      const props = values(api)
      const view = render(<Harness {...props} />)
      await waitFor(() => expect(markRead).toHaveBeenCalledOnce())
      const next = { ...props, loaded: false }
      if (change === 'account') next.accountScope = 'other-account'
      if (change === 'api') next.api = fixture().api
      if (change === 'group') next.groupId = 'other-group'
      if (change === 'item') next.item = { ...item, id: 'G-2' }
      if (change === 'revision') next.item = { ...item, content_revision: 5 }
      if (change === 'inactive') next.active = false
      view.rerender(<Harness {...next} />)
      await act(async () => pending.resolve({ ...item, is_unread: false }))
      expect(props.onRead).not.toHaveBeenCalled()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
    }
  )

  it('ignores a failed request after scope replacement without contaminating the new scope', async () => {
    const { api, markRead } = fixture()
    const pending = deferred<CollaborationIssue>()
    markRead.mockReturnValueOnce(pending.promise)
    const view = render(<Harness {...values(api)} />)
    await waitFor(() => expect(markRead).toHaveBeenCalledOnce())
    view.rerender(<Harness {...values(fixture().api)} accountScope="new" loaded={false} />)
    await act(async () => pending.reject(new Error('old account failed')))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('retains one own request when the same actor changes from canonical0 to string0', async () => {
    const { api, markRead } = fixture()
    const pending = deferred<CollaborationIssue>()
    markRead.mockReturnValueOnce(pending.promise)
    const props = values(api)
    const view = render(<Harness {...props} />)
    await waitFor(() => expect(markRead).toHaveBeenCalledOnce())
    view.rerender(<Harness {...props} actorId="0" />)
    await act(async () => pending.resolve({ ...item, is_unread: false }))
    expect(markRead).toHaveBeenCalledOnce()
    expect(props.onRead).toHaveBeenCalledOnce()
  })

  it('reuses an in-flight receipt when the same visible scope is restored', async () => {
    const { api, markRead } = fixture()
    const pending = deferred<CollaborationIssue>()
    markRead.mockReturnValueOnce(pending.promise)
    const props = values(api)
    const view = render(<Harness {...props} />)
    await waitFor(() => expect(markRead).toHaveBeenCalledOnce())
    view.rerender(<Harness {...props} active={false} />)
    view.rerender(<Harness {...props} active />)
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)))
    await act(async () => pending.resolve({ ...item, is_unread: false }))
    expect(markRead).toHaveBeenCalledOnce()
    expect(props.onRead).toHaveBeenCalledOnce()
  })
})
