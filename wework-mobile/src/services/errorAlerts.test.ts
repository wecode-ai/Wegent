import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Alert, Platform } from 'react-native'
import type { AlertButton } from 'react-native'

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() }, Platform: { OS: 'ios' } }))
const clipboard = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }))
const buttons = () => vi.mocked(Alert.alert).mock.calls.at(-1)![2]!
const button = (text: string): AlertButton => buttons().find(button => button.text === text)!

describe('native error alerts', () => {
  it('serializes a destructive confirmation with error alerts and never runs it on cancel', async () => {
    const { confirmNativeAction, showErrorAlert } = await import('./errorAlerts')
    const remove = vi.fn()
    confirmNativeAction('删除模型', '删除本机配置？', {
      confirmLabel: '删除',
      destructive: true,
      onConfirm: remove,
    })
    showErrorAlert('fetch failed')
    expect(Alert.alert).toHaveBeenCalledOnce()
    expect(button('删除').style).toBe('destructive')
    button('取消').onPress?.()
    expect(remove).not.toHaveBeenCalled()
    expect(Alert.alert).toHaveBeenCalledTimes(2)
    button('关闭').onPress?.()
  })
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    Platform.OS = 'ios'
  })

  it.each(['ios', 'android'] as const)(
    'uses the system alert and platform button order on %s',
    async os => {
      Platform.OS = os
      const { showErrorAlert } = await import('./errorAlerts')
      const retry = vi.fn()
      const dismiss = vi.fn()
      showErrorAlert(new Error('fetch failed https://example.test?token=secret'), {
        onRetry: retry,
        onDismiss: dismiss,
      })
      expect(Alert.alert).toHaveBeenCalledOnce()
      const [title, message, actions, options] = vi.mocked(Alert.alert).mock.calls[0]!
      expect(title).toBe('连接未完成')
      expect(message).not.toContain('https://')
      expect(actions!.map(action => action.text)).toEqual(
        os === 'ios' ? ['关闭', '复制详情', '重试'] : ['复制详情', '关闭', '重试']
      )
      expect(actions).toHaveLength(3)
      expect(retry).not.toHaveBeenCalled()
      button('重试').onPress?.()
      options?.onDismiss?.()
      await Promise.resolve()
      expect(retry).toHaveBeenCalledOnce()
      expect(dismiss).toHaveBeenCalledOnce()
    }
  )

  it('deduplicates repeated failures and serializes distinct failures', async () => {
    const { showErrorAlert } = await import('./errorAlerts')
    showErrorAlert('fetch failed')
    showErrorAlert('fetch failed')
    showErrorAlert('permission denied')
    expect(Alert.alert).toHaveBeenCalledOnce()
    button('关闭').onPress?.()
    expect(Alert.alert).toHaveBeenCalledTimes(2)
    expect(vi.mocked(Alert.alert).mock.calls[1]![0]).toBe('访问权限不足')
  })

  it('does not present queued failures after their screen was removed', async () => {
    const { showErrorAlert } = await import('./errorAlerts')
    showErrorAlert('fetch failed')
    const cancel = showErrorAlert('permission denied')
    cancel()
    button('关闭').onPress?.()
    expect(Alert.alert).toHaveBeenCalledOnce()
  })

  it('retains distinct recovery owners even when their error text matches', async () => {
    const { showErrorAlert } = await import('./errorAlerts')
    const first = vi.fn()
    const second = vi.fn()
    showErrorAlert('fetch failed', { onRetry: first })
    showErrorAlert('fetch failed', { onRetry: second })
    button('关闭').onPress?.()
    expect(Alert.alert).toHaveBeenCalledTimes(2)
    button('重试').onPress?.()
    await Promise.resolve()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('does not run recovery callbacks after the owning screen was removed', async () => {
    const { showErrorAlert } = await import('./errorAlerts')
    const retry = vi.fn()
    const dismiss = vi.fn()
    const cancel = showErrorAlert('fetch failed', { onRetry: retry, onDismiss: dismiss })
    cancel()
    button('重试').onPress?.()
    await Promise.resolve()
    expect(retry).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
  })

  it('shows a retry failure, without automatically repeating the operation', async () => {
    const { showErrorAlert } = await import('./errorAlerts')
    const retry = vi.fn().mockRejectedValue(new Error('permission denied'))
    showErrorAlert('fetch failed', { onRetry: retry })
    button('重试').onPress?.()
    await vi.waitFor(() => expect(Alert.alert).toHaveBeenCalledTimes(2))
    expect(retry).toHaveBeenCalledOnce()
    expect(vi.mocked(Alert.alert).mock.calls[1]![0]).toBe('访问权限不足')
  })

  it('copies only redacted diagnostic details on explicit request', async () => {
    const { showErrorAlert } = await import('./errorAlerts')
    showErrorAlert('fetch failed https://example.test?token=private-value')
    expect(clipboard).not.toHaveBeenCalled()
    button('复制详情').onPress?.()
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce())
    expect(clipboard.mock.calls[0]![0]).not.toContain('private-value')
  })
})
