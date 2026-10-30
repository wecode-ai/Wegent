import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useWeworkIssueLinks } from './useWeworkIssueLinks'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scheme = 'wework://boards/12/issues/ISSUE-1/comments/comment-1'
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
})

describe('native Issue link navigation', () => {
  it('queues a cold-start comment until navigation is ready and consumes it once', async () => {
    const navigate = vi.fn()
    const onConsumed = vi.fn()
    const isReady = vi.fn(() => false)
    let onReady = (): void => undefined
    function Harness() {
      onReady = useWeworkIssueLinks(scheme, undefined, isReady, navigate, onConsumed)
      return null
    }
    await act(async () => {
      renderer = create(<Harness />)
    })
    expect(onConsumed).toHaveBeenCalledOnce()
    expect(navigate).not.toHaveBeenCalled()
    isReady.mockReturnValue(true)
    act(() => onReady())
    act(() => onReady())
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      projectId: '12',
      itemId: 'ISSUE-1',
      commentId: 'comment-1',
      focusRequest: 'mobile-1',
    })
  })

  it('receives HTTPS and repeated scheme links while running with a fresh focus request', async () => {
    const navigate = vi.fn()
    const onConsumed = vi.fn()
    const isReady = () => true
    function Harness({ url }: { url: string | null }) {
      useWeworkIssueLinks(url, 'https://wegent.example', isReady, navigate, onConsumed)
      return null
    }
    await act(async () => {
      renderer = create(<Harness url={scheme} />)
    })
    await act(async () => renderer?.update(<Harness url={null} />))
    await act(async () => renderer?.update(<Harness url={scheme} />))
    await act(async () =>
      renderer?.update(
        <Harness url="https://wegent.example/open-wework?projectId=12&itemId=ISSUE-1&commentId=comment-2" />
      )
    )
    expect(navigate.mock.calls.map(([destination]) => destination)).toEqual([
      { projectId: '12', itemId: 'ISSUE-1', commentId: 'comment-1', focusRequest: 'mobile-1' },
      { projectId: '12', itemId: 'ISSUE-1', commentId: 'comment-1', focusRequest: 'mobile-2' },
      { projectId: '12', itemId: 'ISSUE-1', commentId: 'comment-2', focusRequest: 'mobile-3' },
    ])
  })

  it('consumes unsupported or untrusted links without navigating', async () => {
    const navigate = vi.fn()
    const onConsumed = vi.fn()
    function Harness() {
      useWeworkIssueLinks(
        'https://evil.example/open-wework?projectId=12&itemId=ISSUE-1',
        'https://wegent.example',
        () => true,
        navigate,
        onConsumed
      )
      return null
    }
    await act(async () => {
      renderer = create(<Harness />)
    })
    expect(navigate).not.toHaveBeenCalled()
    expect(onConsumed).toHaveBeenCalledOnce()
  })
})
