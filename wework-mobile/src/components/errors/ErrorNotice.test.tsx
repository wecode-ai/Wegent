import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorNotice } from './ErrorNotice'
import { copyErrorDetails, showErrorAlert } from '@/services/errorAlerts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (value: unknown) => value },
}))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native-paper', () => ({
  Text: 'Text',
  useTheme: () => ({
    colors: { onSurface: '#111', surfaceVariant: '#eee', error: '#b00', primary: '#111' },
  }),
}))
vi.mock('@/services/errorAlerts', () => ({ copyErrorDetails: vi.fn(), showErrorAlert: vi.fn() }))

describe('contextual error notice', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    vi.clearAllMocks()
  })

  it('keeps diagnostics opt-in, retains accessibility and supports scaled/wrapping content', async () => {
    await act(() => {
      renderer = create(
        <ErrorNotice error="fetch failed https://example.test?token=private-token" />
      )
    })
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('连接未完成')
    expect(json).not.toContain('https://')
    expect(json).not.toContain('private-token')
    expect(copyErrorDetails).not.toHaveBeenCalled()
    const alert = renderer.root.findByProps({ accessibilityRole: 'alert' })
    expect(alert.props.accessibilityLiveRegion).toBe('polite')
    const copy = renderer.root.findByProps({ accessibilityLabel: '复制错误详情' })
    expect(copy.props.style.minHeight).toBe(48)
    expect(copy.props.style.minWidth).toBe(48)
    expect(
      renderer.root
        .findAll(node => node.type === ('Text' as never))
        .every(node => node.props.numberOfLines === undefined)
    ).toBe(true)
    await act(() => copy.props.onPress())
    expect(copyErrorDetails).toHaveBeenCalledOnce()
    expect(vi.mocked(copyErrorDetails).mock.calls[0]![0]).not.toContain('private-token')
  })

  it('never automatically repeats an operation and makes retry failures visible', async () => {
    const retry = vi.fn().mockRejectedValue(new Error('permission denied'))
    await act(() => {
      renderer = create(<ErrorNotice error="fetch failed" onRetry={retry} />)
    })
    expect(retry).not.toHaveBeenCalled()
    const button = renderer.root
      .findAllByProps({ testID: 'error-notice-retry' })
      .find(node => typeof node.type === 'string')!
    await act(() => button.props.onPress())
    expect(retry).toHaveBeenCalledOnce()
    expect(showErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'permission denied' }),
      { title: undefined, onRetry: retry }
    )
  })
})
