import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useWorkspaceFileReveal } from './useWorkspaceFileReveal'

const initial = {
  rootPath: '/fixture/repo',
  selectedPath: '/fixture/repo/src/api/a.py',
  visible: false,
  refreshVersion: 0,
}

test('loads ancestors on reveal and resumes after an explicit retry', async () => {
  const loadDirectory = vi.fn().mockResolvedValue(true).mockResolvedValueOnce(false)
  const { rerender } = renderHook(props => useWorkspaceFileReveal({ ...props, loadDirectory }), {
    initialProps: initial,
  })
  expect(loadDirectory).not.toHaveBeenCalled()
  rerender({ ...initial, visible: true })
  await waitFor(() => expect(loadDirectory).toHaveBeenCalledTimes(1))
  expect(loadDirectory).toHaveBeenCalledWith('/fixture/repo/src')
  rerender({ ...initial, visible: true, refreshVersion: 1 })
  await waitFor(() => expect(loadDirectory).toHaveBeenCalledTimes(3))
  expect(loadDirectory).toHaveBeenLastCalledWith('/fixture/repo/src/api')
})

test('does not continue revealing an old file after a switch', async () => {
  let resolve!: (loaded: boolean) => void
  const loadDirectory = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>(done => {
          resolve = done
        })
    )
    .mockResolvedValue(true)
  const { rerender } = renderHook(props => useWorkspaceFileReveal({ ...props, loadDirectory }), {
    initialProps: { ...initial, visible: true },
  })
  rerender({ ...initial, visible: true, selectedPath: '/fixture/repo/docs/readme.md' })
  await act(async () => {
    resolve(true)
  })
  expect(loadDirectory.mock.calls.map(([path]) => path)).toEqual([
    '/fixture/repo/src',
    '/fixture/repo/docs',
  ])
})
