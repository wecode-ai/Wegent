import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useIssueFieldSaves } from '../../../../packages/collaboration/src/issue-detail/useIssueFieldSaves'

const initial = {
  id: 'one',
  version: 1,
  title: 'Original',
  status: 'pending',
  description: 'Saved',
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('Issue field save queue', () => {
  it('serializes rapid edits using accepted versions even before the host refreshes', async () => {
    const accept = vi.fn()
    const first = deferred<typeof initial>()
    const { result } = renderHook(() => useIssueFieldSaves(initial, accept))
    const later = vi.fn(async (source: typeof initial) => ({
      ...source,
      status: 'completed',
      version: source.version + 1,
    }))
    let one!: Promise<unknown>
    let two!: Promise<unknown>
    act(() => {
      one = result.current.save('title', () => first.promise)
      two = result.current.save('status', later)
    })
    expect(result.current.pending).toBe(true)
    expect(later).not.toHaveBeenCalled()
    await act(async () => {
      first.resolve({ ...initial, title: 'Changed', version: 2 })
      await Promise.all([one, two])
    })
    expect(later).toHaveBeenCalledWith({ ...initial, title: 'Changed', version: 2 })
    expect(accept).toHaveBeenLastCalledWith({
      ...initial,
      title: 'Changed',
      status: 'completed',
      version: 3,
    })
    expect(result.current.pending).toBe(false)
  })

  it('reports a failed save to the current host callback only', async () => {
    const original = vi.fn()
    const latest = vi.fn()
    const pending = Promise.withResolvers<typeof initial>()
    const { result, rerender } = renderHook(
      ({ report }) => useIssueFieldSaves(initial, vi.fn(), report),
      { initialProps: { report: original } }
    )
    let save!: Promise<unknown>
    act(() => {
      save = result.current.save('title', () => pending.promise)
    })
    rerender({ report: latest })
    const error = new Error('Save failed')
    await act(async () => {
      pending.reject(error)
      await save
    })
    expect(original).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith(error)
    expect(result.current.error).toBe(error)
  })

  it('retains failed operations for explicit retry without blocking unrelated fields', async () => {
    const accept = vi.fn()
    const failed = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockImplementation(async (source: typeof initial) => ({
        ...source,
        title: 'Changed',
        version: source.version + 1,
      }))
    const { result } = renderHook(() => useIssueFieldSaves(initial, accept))
    await act(async () => {
      await result.current.save('title', failed)
    })
    expect(result.current.error).toEqual(new Error('Offline'))
    await act(async () => {
      await result.current.save('status', async source => ({
        ...source,
        status: 'completed',
        version: 2,
      }))
    })
    expect(result.current.error).toEqual(new Error('Offline'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.error).toBeNull())
    expect(failed).toHaveBeenLastCalledWith({ ...initial, status: 'completed', version: 2 })
    expect(accept).toHaveBeenLastCalledWith({
      ...initial,
      title: 'Changed',
      status: 'completed',
      version: 3,
    })
  })

  it('finishes queued writes for the original Issue without applying responses to the next Issue', async () => {
    const accept = vi.fn()
    const first = deferred<typeof initial>()
    const skipped = vi.fn(async (source: typeof initial) => source)
    const { result, rerender } = renderHook(({ source }) => useIssueFieldSaves(source, accept), {
      initialProps: { source: initial },
    })
    let pending!: Promise<unknown>
    let queued!: Promise<unknown>
    act(() => {
      pending = result.current.save('title', () => first.promise)
      queued = result.current.save('status', skipped)
    })
    await act(async () => {
      await Promise.resolve()
    })
    rerender({ source: { ...initial, id: 'two' } })
    await act(async () => {
      first.resolve({ ...initial, version: 2 })
      await Promise.all([pending, queued])
    })
    expect(accept).not.toHaveBeenCalled()
    expect(skipped).toHaveBeenCalledWith({ ...initial, version: 2 })
    expect(result.current.pending).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('does not replace a newer server refresh with an older in-flight response', async () => {
    const accept = vi.fn()
    const pending = deferred<typeof initial>()
    const { result, rerender } = renderHook(({ source }) => useIssueFieldSaves(source, accept), {
      initialProps: { source: initial },
    })
    let save!: Promise<unknown>
    act(() => {
      save = result.current.save('title', () => pending.promise)
    })
    await act(async () => {
      await Promise.resolve()
    })
    rerender({ source: { ...initial, title: 'Server revision', version: 4 } })
    await act(async () => {
      pending.resolve({ ...initial, title: 'Older response', version: 2 })
      await save
    })
    expect(accept).not.toHaveBeenCalled()
    const next = vi.fn(async (source: typeof initial) => ({
      ...source,
      status: 'completed',
      version: 5,
    }))
    await act(async () => {
      await result.current.save('status', next)
    })
    expect(next).toHaveBeenCalledWith({ ...initial, title: 'Server revision', version: 4 })
  })

  it('clears a failed field after a newer successful edit of that field', async () => {
    const { result } = renderHook(() => useIssueFieldSaves(initial, vi.fn()))
    await act(async () => {
      await result.current.save('title', async () => {
        throw new Error('Rejected')
      })
    })
    await act(async () => {
      await result.current.save('title', async source => ({
        ...source,
        title: 'Corrected',
        version: 2,
      }))
    })
    expect(result.current.error).toBeNull()
  })
})
