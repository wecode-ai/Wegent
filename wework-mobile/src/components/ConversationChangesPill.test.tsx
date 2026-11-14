import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationChangesPill } from './ConversationChangesPill'
import { FilePreviewContext, type MobileFilePreviewActions } from './files/FilePreviewContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const events = vi.hoisted(() => ({ active: undefined as undefined | ((state: string) => void) }))
vi.mock('@react-navigation/native', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) }
})
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_: string, callback: (state: string) => void) => {
      events.active = callback
      return {
        remove: () => {
          events.active = undefined
        },
      }
    },
  },
  StyleSheet: { create: (value: unknown) => value },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({ dark: false, colors: {} }),
}))
vi.mock('./LiquidGlass', () => ({ LiquidGlassButton: 'GlassButton' }))

describe('conversation changes summary', () => {
  let renderer: ReactTestRenderer
  const loadChanges = vi.fn()
  const openChangesBrowser = vi.fn()
  const target = { deviceId: 'device-a', path: '/worktree' }
  let actions: MobileFilePreviewActions
  const summary = { fileCount: 9, additions: 1004, deletions: 383 }
  function tree(revision = 'task-a:complete') {
    return (
      <FilePreviewContext.Provider value={actions}>
        <ConversationChangesPill revision={revision} />
      </FilePreviewContext.Provider>
    )
  }
  beforeEach(() => {
    vi.clearAllMocks()
    actions = { target, loadChanges, openChangesBrowser } as unknown as MobileFilePreviewActions
    loadChanges.mockResolvedValue(summary)
  })
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
  })
  const pill = () => renderer.root.findByType('GlassButton' as never)
  it('shows real counts, opens changes, and does not refetch for unrelated rerenders', async () => {
    await act(() => {
      renderer = create(tree())
    })
    expect(pill().props.accessibilityLabel).toBe('9 个文件，新增 1004 行，删除 383 行')
    await act(() => renderer.update(tree()))
    expect(loadChanges).toHaveBeenCalledTimes(1)
    await act(() => pill().props.onPress())
    expect(openChangesBrowser).toHaveBeenCalledOnce()
    await act(() => events.active?.('active'))
    expect(loadChanges).toHaveBeenCalledTimes(2)
  })
  it('aborts previous workspace reads and never displays their late counts', async () => {
    let resolve!: (value: unknown) => void
    loadChanges.mockImplementationOnce(
      () =>
        new Promise(done => {
          resolve = done
        })
    )
    await act(() => {
      renderer = create(tree())
    })
    const oldSignal = loadChanges.mock.calls[0]![1] as AbortSignal
    actions = { ...actions, target: { ...target, deviceId: 'device-b' } }
    loadChanges.mockResolvedValue({ ...summary, fileCount: 2 })
    await act(() => renderer.update(tree()))
    expect(oldSignal.aborted).toBe(true)
    await act(() => resolve({ ...summary, fileCount: 99 }))
    expect(pill().props.accessibilityLabel).toContain('2 个文件')
  })
  it('keeps a failed load actionable and recovers on the next completed turn', async () => {
    loadChanges.mockRejectedValueOnce(new Error('Device offline'))
    await act(() => {
      renderer = create(tree())
    })
    expect(pill().props.accessibilityLabel).toBe('更改加载失败，打开重试')
    await act(() => renderer.update(tree('task-a:next-turn')))
    expect(pill().props.accessibilityLabel).toContain('9 个文件')
  })
  it('hides empty changes instead of inventing counts', async () => {
    loadChanges.mockResolvedValue({ ...summary, fileCount: 0 })
    await act(() => {
      renderer = create(tree())
    })
    expect(renderer.root.findAllByType('GlassButton' as never)).toHaveLength(0)
  })
})
