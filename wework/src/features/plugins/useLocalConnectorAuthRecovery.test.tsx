import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import type { LocalConnectorAuthResult } from '@/api/local/localConnectorAuth'
import type { WorkbenchMessage } from '@/types/workbench'
import { WORKBENCH_NEW_CHAT_STARTED_EVENT } from '@/lib/workbenchComposerFocus'
import { useLocalConnectorAuthRecovery } from './useLocalConnectorAuthRecovery'

const mocks = vi.hoisted(() => ({ health: vi.fn(), createPluginApi: vi.fn() }))

vi.mock('@/api/local/localConnectorAuth', async original => ({
  ...(await original<typeof import('@/api/local/localConnectorAuth')>()),
  localConnectorAuthHealth: mocks.health,
}))
vi.mock('@/api/local/codexPlugins', () => ({
  createLocalCodexPluginApi: mocks.createPluginApi,
}))

const target = { pluginKey: 'weibo-api-wiki', connectorSlug: 'weibo-wiki' }
const pluginInput = '[$Wiki](plugin://weibo-api-wiki@wegent) 查看接口'
const authMessage: WorkbenchMessage = {
  id: 'assistant-auth-1',
  role: 'assistant',
  content: 'connector_auth_required\npluginKey=weibo-api-wiki\nconnectorSlug=weibo-wiki',
  status: 'failed',
  createdAt: '2026-10-15T00:00:00Z',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderRecovery(messages = [authMessage], onResumeSend = vi.fn()) {
  return renderHook(
    ({ currentMessages, active }: { currentMessages: WorkbenchMessage[]; active: boolean }) =>
      useLocalConnectorAuthRecovery({
        messages: currentMessages,
        active,
        onResumeSend,
        cloudConnection: { apiBaseUrl: 'https://wegent.test/api', token: 'cloud-token' },
      }),
    { initialProps: { currentMessages: messages, active: true } }
  )
}

beforeEach(() => {
  mocks.health.mockReset().mockResolvedValue({ status: 'need_login' })
  mocks.createPluginApi.mockReset()
})

afterEach(() => {
  expect(mocks.createPluginApi).not.toHaveBeenCalled()
})

describe('authorization after plugin use', () => {
  test.each(['empty', 'ordinary', 'plugin-reference'])(
    '%s chat performs no authorization reads',
    kind => {
      const messages: WorkbenchMessage[] =
        kind === 'empty'
          ? []
          : [{ ...authMessage, role: 'user', content: kind === 'ordinary' ? 'Hello' : pluginInput }]
      const { result } = renderRecovery(messages)

      expect(mocks.health).not.toHaveBeenCalled()
      expect(result.current.pending).toBeNull()
    }
  )

  test('targets the reported plugin without reading installed lists or details', async () => {
    const { result } = renderRecovery()

    await waitFor(() => expect(result.current.pending?.target).toEqual(target))
    expect(mocks.health).toHaveBeenCalledExactlyOnceWith(target, { bypassCache: true })
    expect(result.current.pending?.title).toBeUndefined()
  })

  test('recognizes structured errors without reading the original user request', async () => {
    const { result } = renderRecovery([
      {
        ...authMessage,
        role: 'system',
        content: '',
        error: JSON.stringify({ error: 'connector_auth_required', ...target }),
      },
    ])

    await waitFor(() => expect(result.current.pending?.target).toEqual(target))
  })

  test.each([
    '请登录后重试。',
    'connector_auth_required\npluginKey=weibo-api-wiki',
    '插件无法连接\npluginKey=weibo-api-wiki\nconnectorSlug=weibo-wiki',
  ])('does not guess an authorization target from %s', content => {
    const { result } = renderRecovery([{ ...authMessage, content }])

    expect(mocks.health).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  })

  test('opens the cloud authorization card for a slug-only connector request', async () => {
    const { result } = renderRecovery([
      {
        ...authMessage,
        content: 'connector_auth_required\nconnectorSlug=dingtalk_log',
        error: JSON.stringify({
          error: 'connector_auth_required',
          connectorSlug: 'dingtalk_log',
        }),
      },
    ])

    await waitFor(() => expect(result.current.pending?.cloud).toEqual({ slug: 'dingtalk_log' }))
    // Cloud apps are authorized by Wegent, so no local health probe runs.
    expect(mocks.health).not.toHaveBeenCalled()
  })

  test.each(['pending', 'streaming'] as const)(
    'waits until a %s message becomes terminal before checking authorization',
    async status => {
      const { result, rerender } = renderRecovery([{ ...authMessage, status }])
      expect(mocks.health).not.toHaveBeenCalled()

      rerender({ currentMessages: [{ ...authMessage, status: 'done' }], active: true })

      await waitFor(() => expect(result.current.pending?.target).toEqual(target))
      expect(mocks.health).toHaveBeenCalledTimes(1)
    }
  )

  test('does not duplicate a probe when unrelated message data changes', async () => {
    const response = deferred<LocalConnectorAuthResult>()
    mocks.health.mockReturnValue(response.promise)
    const { result, rerender } = renderRecovery()

    rerender({
      currentMessages: [{ ...authMessage, content: authMessage.content + '\n' }],
      active: true,
    })
    expect(mocks.health).toHaveBeenCalledTimes(1)
    await act(async () => response.resolve({ status: 'need_login' }))
    expect(result.current.pending?.target).toEqual(target)
  })

  test.each(['ok', 'need_scan'] as const)('handles the live health status %s', async status => {
    mocks.health.mockResolvedValue({ status })
    const { result, rerender } = renderRecovery()

    await act(async () => undefined)
    expect(result.current.pending?.target ?? null).toEqual(status === 'ok' ? null : target)
    rerender({ currentMessages: [{ ...authMessage }], active: true })
    expect(mocks.health).toHaveBeenCalledTimes(1)
  })

  test.each(['transport', 'error', 'waiting_browser'])(
    'reports %s failures without starting a login flow',
    async failure => {
      if (failure === 'transport') mocks.health.mockRejectedValue(new Error('offline'))
      else mocks.health.mockResolvedValue({ status: failure })
      const onError = vi.fn()
      const { result, rerender } = renderHook(
        ({ messages }) =>
          useLocalConnectorAuthRecovery({ messages, onResumeSend: vi.fn(), onError }),
        { initialProps: { messages: [authMessage] } }
      )

      await waitFor(() => expect(onError).toHaveBeenCalledOnce())
      expect(result.current.pending).toBeNull()
      rerender({ messages: [{ ...authMessage }] })
      expect(mocks.health).toHaveBeenCalledTimes(1)
    }
  )

  test('asks to install the plugin when it is missing from this app', async () => {
    const missing = new Error("Installed plugin 'weibo-api-wiki' was not found on this device")
    Object.assign(missing, { code: 'plugin_not_installed' })
    mocks.health.mockRejectedValue(missing)
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useLocalConnectorAuthRecovery({ messages: [authMessage], onResumeSend: vi.fn(), onError })
    )

    await waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(
      i18n.t('common:workbench.plugins_local_auth_plugin_missing', {
        plugin: target.pluginKey,
      })
    )
    expect(result.current.pending).toBeNull()
  })

  test('only the active pane probes an unhandled failure', async () => {
    const { result, rerender } = renderHook(
      ({ active }) =>
        useLocalConnectorAuthRecovery({ messages: [authMessage], active, onResumeSend: vi.fn() }),
      { initialProps: { active: false } }
    )
    expect(mocks.health).not.toHaveBeenCalled()

    rerender({ active: true })

    await waitFor(() => expect(result.current.pending?.target).toEqual(target))
  })

  test.each(['cancel', 'new-chat'])(
    '%s consumes a pending failure so it cannot reopen on a later render',
    async action => {
      const onSend = vi.fn()
      const { result, rerender } = renderRecovery([authMessage], onSend)
      await waitFor(() => expect(result.current.pending).not.toBeNull())

      act(() => {
        if (action === 'new-chat') window.dispatchEvent(new Event(WORKBENCH_NEW_CHAT_STARTED_EVENT))
        else result.current.clearPending()
      })
      rerender({ currentMessages: [{ ...authMessage }], active: true })
      await act(async () => result.current.completePending())

      expect(result.current.pending).toBeNull()
      expect(mocks.health).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    }
  )

  test.each(['submission', 'new-chat', 'unmount'])(
    'ignores a late health result after %s',
    async action => {
      const response = deferred<LocalConnectorAuthResult>()
      mocks.health.mockReturnValue(response.promise)
      const onSend = vi.fn()
      const { result, rerender, unmount } = renderRecovery([authMessage], onSend)
      expect(mocks.health).toHaveBeenCalledOnce()

      if (action === 'unmount') unmount()
      else {
        act(() => {
          if (action === 'new-chat')
            window.dispatchEvent(new Event(WORKBENCH_NEW_CHAT_STARTED_EVENT))
          else result.current.clearPending()
        })
      }
      await act(async () => response.resolve({ status: 'need_login' }))
      if (action === 'unmount') return
      rerender({ currentMessages: [{ ...authMessage }], active: true })
      await act(async () => result.current.completePending())

      expect(result.current.pending).toBeNull()
      expect(mocks.health).toHaveBeenCalledOnce()
      expect(onSend).not.toHaveBeenCalled()
    }
  )

  test('returning to a pane restores its unresolved login and rejects an obsolete success callback', async () => {
    const onSend = vi.fn()
    const { result, rerender } = renderRecovery([authMessage], onSend)
    await waitFor(() => expect(result.current.pending?.target).toEqual(target))
    const completePrevious = result.current.completePending

    rerender({ currentMessages: [authMessage], active: false })
    expect(result.current.pending).toBeNull()
    await act(async () => completePrevious())
    expect(onSend).not.toHaveBeenCalled()
    rerender({ currentMessages: [authMessage], active: true })
    await waitFor(() => expect(result.current.pending?.target).toEqual(target))

    await act(async () => completePrevious())
    expect(onSend).not.toHaveBeenCalled()
    expect(result.current.pending?.target).toEqual(target)
    await act(async () => result.current.completePending())

    expect(mocks.health).toHaveBeenCalledTimes(2)
    expect(onSend).toHaveBeenCalledExactlyOnceWith(
      i18n.t('common:workbench.plugins_local_auth_resume_prompt')
    )
  })

  test('a probe interrupted by pane deactivation can restart without accepting its late result', async () => {
    const response = deferred<LocalConnectorAuthResult>()
    mocks.health.mockReturnValueOnce(response.promise)
    const { result, rerender } = renderRecovery()
    expect(mocks.health).toHaveBeenCalledOnce()

    rerender({ currentMessages: [authMessage], active: false })
    await act(async () => response.resolve({ status: 'need_login' }))
    expect(result.current.pending).toBeNull()
    expect(mocks.health).toHaveBeenCalledOnce()
    rerender({ currentMessages: [authMessage], active: true })

    await waitFor(() => expect(result.current.pending?.target).toEqual(target))
    expect(mocks.health).toHaveBeenCalledTimes(2)
  })

  test('ignores a late transport error after a new submission', async () => {
    const response = deferred<LocalConnectorAuthResult>()
    mocks.health.mockReturnValue(response.promise)
    const onError = vi.fn()
    const { result } = renderHook(() =>
      useLocalConnectorAuthRecovery({ messages: [authMessage], onResumeSend: vi.fn(), onError })
    )

    act(() => result.current.clearPending())
    await act(async () => response.reject(new Error('offline')))

    expect(onError).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  })

  test('a stale probe cannot replace recovery for a newer failure', async () => {
    const previous = deferred<LocalConnectorAuthResult>()
    mocks.health.mockReturnValueOnce(previous.promise)
    const { result, rerender } = renderRecovery()
    const next = { ...authMessage, id: 'assistant-auth-2' }

    rerender({ currentMessages: [authMessage, next], active: true })
    await waitFor(() => expect(result.current.pending).not.toBeNull())
    await act(async () => previous.resolve({ status: 'need_scan' }))

    expect(mocks.health).toHaveBeenCalledTimes(2)
    expect(result.current.pending?.target).toEqual(target)
  })

  test.each(['user', 'assistant'] as const)(
    'a newer %s message invalidates a pending login without requiring composer submission',
    async role => {
      const onSend = vi.fn()
      const { result, rerender } = renderRecovery([authMessage], onSend)
      await waitFor(() => expect(result.current.pending).not.toBeNull())
      const completePrevious = result.current.completePending

      rerender({
        currentMessages: [
          authMessage,
          { ...authMessage, id: 'new-message', role, content: 'Hello' },
        ],
        active: true,
      })
      await act(async () => completePrevious())

      expect(result.current.pending).toBeNull()
      expect(onSend).not.toHaveBeenCalled()
      expect(mocks.health).toHaveBeenCalledOnce()
    }
  )

  test('a newer identified failure can replace a pending card', async () => {
    const { result, rerender } = renderRecovery()
    await waitFor(() => expect(result.current.pending?.target).toEqual(target))
    const nextTarget = { pluginKey: 'gitlab-intra', connectorSlug: 'gitlab' }

    rerender({
      currentMessages: [
        authMessage,
        {
          ...authMessage,
          id: 'new-auth-failure',
          content: JSON.stringify({ error: 'connector_auth_required', ...nextTarget }),
        },
      ],
      active: true,
    })

    await waitFor(() => expect(result.current.pending?.target).toEqual(nextTarget))
    expect(mocks.health).toHaveBeenCalledTimes(2)
  })

  test.each(['failed', 'done'] as const)(
    '%s recovery continues once without replaying the original request',
    async status => {
      const onSend = vi.fn()
      const { result, rerender } = renderRecovery(
        [
          { ...authMessage, role: 'user', content: pluginInput },
          { ...authMessage, status },
        ],
        onSend
      )
      await waitFor(() => expect(result.current.pending).not.toBeNull())

      await act(async () => {
        await Promise.all([result.current.completePending(), result.current.completePending()])
      })
      rerender({ currentMessages: [{ ...authMessage, status }], active: true })

      expect(onSend).toHaveBeenCalledExactlyOnceWith(
        i18n.t('common:workbench.plugins_local_auth_resume_prompt')
      )
      expect(onSend).not.toHaveBeenCalledWith(pluginInput)
      expect(result.current.pending).toBeNull()
      expect(mocks.health).toHaveBeenCalledOnce()
    }
  )

  test('a later authorization failure can recover after an earlier one was cancelled', async () => {
    const { result, rerender } = renderRecovery()
    await waitFor(() => expect(result.current.pending).not.toBeNull())
    act(() => result.current.clearPending())

    rerender({ currentMessages: [{ ...authMessage, id: 'assistant-auth-2' }], active: true })

    await waitFor(() => expect(result.current.pending).not.toBeNull())
    expect(mocks.health).toHaveBeenCalledTimes(2)
  })
})
