import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import {
  clearLocalCodexPluginsReadStateCache,
  createLocalCodexPluginApi,
} from '@/api/local/codexPlugins'
import { clearLocalConnectorAuthHealthCache } from '@/api/local/localConnectorAuth'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { DesktopEmptyTaskLauncher } from '@/components/layout/DesktopEmptyTaskLauncher'
import { useLocalConnectorAuthGate } from './useLocalConnectorAuthGate'
import type { WorkbenchMessage } from '@/types/workbench'

const mocks = vi.hoisted(() => ({ requestLocalExecutor: vi.fn() }))

vi.mock('@/lib/runtime-environment', () => ({
  isDesktopRuntime: () => true,
  isElectronRuntime: () => true,
}))

vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: async () => ({ deviceId: 'test-device' }),
  ensureBundledPluginMarketplaceRegistered: async () => undefined,
  getInitializedBundledPluginMarketplace: () => null,
  getKnownLocalExecutorDeviceId: () => 'test-device',
  requestLocalExecutor: (...args: unknown[]) => mocks.requestLocalExecutor(...args),
}))

const marketplacePath =
  '/executor/codex/plugins/marketplaces/wegent/.agents/plugins/marketplace.json'
const pluginName = 'weibo-api-wiki'
const input = '[$微博开放平台内部WIKI](plugin://weibo-api-wiki@wegent) 查看用户信息接口'
const summary = {
  id: `${pluginName}@wegent`,
  name: pluginName,
  installed: true,
  enabled: true,
  interface: { displayName: '微博开放平台内部WIKI' },
}
const localAuth = {
  kind: 'local_qr',
  health: ['scripts/run-weibo-wiki.sh', 'health'],
  start: ['scripts/run-weibo-wiki.sh', 'auth', 'start'],
  poll: ['scripts/run-weibo-wiki.sh', 'auth', 'status'],
  pollIntervalSeconds: 0.1,
}
const userMessage: WorkbenchMessage = {
  id: 'user-1',
  role: 'user',
  content: input,
  status: 'done',
  createdAt: '2026-09-15T00:00:00Z',
}
const authMessage: WorkbenchMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: 'connector_auth_required\npluginKey=weibo-api-wiki\nconnectorSlug=weibo-wiki',
  status: 'failed',
  createdAt: '2026-09-15T00:00:01Z',
}

function AuthConversation({
  messages,
  onSend,
  onRetry,
}: {
  messages: WorkbenchMessage[]
  onSend: (input: string) => void
  onRetry: (message: WorkbenchMessage) => boolean
}) {
  const gate = useLocalConnectorAuthGate({
    messages,
    onResumeSend: onSend,
    onRetryMessage: onRetry,
  })
  const composer = (
    <>
      <button
        data-testid="test-send"
        onClick={async () => {
          if ((await gate.gateBeforeSend(input)) === 'send') onSend(input)
        }}
      >
        Send
      </button>
      <button
        data-testid="test-send-ordinary"
        onClick={async () => {
          if ((await gate.gateBeforeSend('ordinary message')) === 'send') {
            onSend('ordinary message')
          }
        }}
      >
        Send ordinary message
      </button>
    </>
  )
  const card = gate.pending ? (
    <ConnectorAuthCard
      target={gate.pending.target}
      title={gate.pending.title}
      onSuccess={() => void gate.completePending()}
      onCancel={gate.clearPending}
    />
  ) : null
  return messages.length === 0 ? (
    <DesktopEmptyTaskLauncher
      compact
      onOpenProjectSelector={() => undefined}
      onSelectSuggestion={() => undefined}
      composer={composer}
      connectorAuthCard={card}
    />
  ) : (
    <>
      {card}
      {composer}
    </>
  )
}

describe('managed Wiki conversation authorization', () => {
  beforeEach(() => {
    window.localStorage.clear()
    clearLocalCodexPluginsReadStateCache()
    clearLocalConnectorAuthHealthCache()
    mocks.requestLocalExecutor.mockReset()
  })

  afterEach(() => {
    clearLocalCodexPluginsReadStateCache()
    clearLocalConnectorAuthHealthCache()
  })

  test('uses the new connector after a release replaces an already-known localAuth stub', async () => {
    let connectorSlug = 'wiki-old'
    mocks.requestLocalExecutor.mockImplementation(async (method, params) => {
      if (method === 'executor.plugins.store.list') return { plugins: [] }
      if (method === 'codex.app_server_request') {
        if (params.method === 'plugin/installed') {
          return { marketplaces: [{ name: 'wegent', path: marketplacePath, plugins: [summary] }] }
        }
        if (params.method === 'plugin/read') return { plugin: { summary, connectors: [] } }
      }
      if (method === 'executor.plugins.manifest.read') {
        return { connectors: [{ slug: connectorSlug, authPolicy: 'on_use', localAuth }] }
      }
      if (method === 'runtime.local_connector_auth.health') {
        expect(params.connectorSlug).toBe(connectorSlug)
        return { status: 'ok' }
      }
      throw new Error(`Unexpected executor method: ${method}`)
    })
    const { result } = renderHook(() =>
      useLocalConnectorAuthGate({ messages: [], onResumeSend: vi.fn(), onRetryMessage: vi.fn() })
    )
    expect(await result.current.gateBeforeSend(input)).toBe('send')
    connectorSlug = 'wiki-local'
    expect(await result.current.gateBeforeSend(input)).toBe('send')
    expect(result.current.pending).toBeNull()
    const probes = mocks.requestLocalExecutor.mock.calls.filter(
      ([method]) => method === 'runtime.local_connector_auth.health'
    )
    expect(probes.map(([, params]) => params.connectorSlug)).toEqual(['wiki-old', 'wiki-local'])
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method]) => method === 'executor.plugins.manifest.read'
      )
    ).toHaveLength(2)
  })

  test('runs resume authorization only in the active workbench pane', async () => {
    mocks.requestLocalExecutor.mockImplementation(async (method, params) => {
      if (method === 'executor.plugins.store.list') return { plugins: [] }
      if (method === 'codex.app_server_request') {
        if (params.method === 'plugin/installed') {
          return { marketplaces: [{ name: 'wegent', path: marketplacePath, plugins: [summary] }] }
        }
        if (params.method === 'plugin/read') {
          return { plugin: { summary, skills: [], hooks: [], connectors: [] } }
        }
      }
      if (method === 'executor.plugins.manifest.read') {
        return {
          connectors: [{ slug: 'weibo-wiki', authPolicy: 'on_install', localAuth }],
        }
      }
      if (method === 'runtime.local_connector_auth.health') return { status: 'need_login' }
      throw new Error(`Unexpected executor method: ${method}`)
    })
    const options = {
      messages: [userMessage, authMessage],
      onResumeSend: vi.fn(),
      onRetryMessage: vi.fn(),
    }
    const { result, rerender } = renderHook(
      ({ active }) => useLocalConnectorAuthGate({ ...options, active }),
      { initialProps: { active: false } }
    )

    await act(async () => undefined)
    expect(result.current.pending).toBeNull()
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method]) => method === 'runtime.local_connector_auth.health'
      )
    ).toHaveLength(0)

    rerender({ active: true })
    await waitFor(() => expect(result.current.pending?.mode).toBe('resume'))
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method]) => method === 'runtime.local_connector_auth.health'
      )
    ).toHaveLength(1)

    rerender({ active: false })
    await waitFor(() => expect(result.current.pending).toBeNull())

    rerender({ active: true })
    await waitFor(() => expect(result.current.pending?.mode).toBe('resume'))
    expect(
      mocks.requestLocalExecutor.mock.calls.filter(
        ([method]) => method === 'runtime.local_connector_auth.health'
      )
    ).toHaveLength(2)
  })

  test('discards an in-flight preflight when the workbench pane becomes inactive', async () => {
    let finishHealth: ((result: { status: string }) => void) | undefined
    mocks.requestLocalExecutor.mockImplementation(async (method, params) => {
      if (method === 'executor.plugins.store.list') return { plugins: [] }
      if (method === 'codex.app_server_request') {
        if (params.method === 'plugin/installed') {
          return { marketplaces: [{ name: 'wegent', path: marketplacePath, plugins: [summary] }] }
        }
        if (params.method === 'plugin/read') {
          return { plugin: { summary, skills: [], hooks: [], connectors: [] } }
        }
      }
      if (method === 'executor.plugins.manifest.read') {
        return {
          connectors: [{ slug: 'weibo-wiki', authPolicy: 'on_use', localAuth }],
        }
      }
      if (method === 'runtime.local_connector_auth.health') {
        return await new Promise(resolve => {
          finishHealth = resolve
        })
      }
      throw new Error(`Unexpected executor method: ${method}`)
    })
    const options = {
      messages: [],
      onResumeSend: vi.fn(),
      onRetryMessage: vi.fn(),
    }
    const { result, rerender } = renderHook(
      ({ active }) => useLocalConnectorAuthGate({ ...options, active }),
      { initialProps: { active: true } }
    )

    const preflight = result.current.gateBeforeSend(input)
    await waitFor(() => expect(finishHealth).toBeTypeOf('function'))
    rerender({ active: false })
    finishHealth?.({ status: 'need_login' })

    await expect(preflight).resolves.toBe('blocked')
    expect(result.current.pending).toBeNull()
  })

  test.each(['transport', 'health-result', 'manifest'])(
    'does not show login or send a plugin draft when connection detection fails: %s',
    async failure => {
      mocks.requestLocalExecutor.mockImplementation(async (method, params) => {
        if (method === 'executor.plugins.store.list') return { plugins: [] }
        if (method === 'codex.app_server_request') {
          if (params.method === 'plugin/installed') {
            return { marketplaces: [{ name: 'wegent', path: marketplacePath, plugins: [summary] }] }
          }
          if (params.method === 'plugin/read') {
            if (failure === 'manifest') throw new Error('plugin/read failed')
            return { plugin: { summary, connectors: [] } }
          }
        }
        if (method === 'executor.plugins.manifest.read') {
          return { connectors: [{ slug: 'weibo-wiki', authPolicy: 'on_use', localAuth }] }
        }
        if (method === 'runtime.local_connector_auth.health') {
          if (failure === 'transport')
            throw new Error('Plugin does not declare a localAuth connector')
          return { status: 'error', hint: 'Provider unavailable' }
        }
        throw new Error(`Unexpected executor method: ${method}`)
      })
      const onError = vi.fn()
      const { result } = renderHook(() =>
        useLocalConnectorAuthGate({
          messages: [],
          onResumeSend: vi.fn(),
          onRetryMessage: vi.fn(),
          onError,
        })
      )
      expect(await result.current.gateBeforeSend(input)).toBe('blocked')
      expect(onError).toHaveBeenCalledOnce()
      expect(result.current.pending).toBeNull()
      expect(await result.current.gateBeforeSend('ordinary message')).toBe('send')
      expect(
        mocks.requestLocalExecutor.mock.calls.some(
          ([method]) => method === 'runtime.local_connector_auth.start'
        )
      ).toBe(false)
    }
  )

  test.each([
    { accountManaged: false, mode: 'preflight' },
    { accountManaged: false, mode: 'resume' },
    { accountManaged: true, mode: 'preflight' },
    { accountManaged: true, mode: 'resume' },
    { accountManaged: false, mode: 'resume-done' },
    { accountManaged: true, mode: 'resume-done' },
    { accountManaged: false, mode: 'preflight', action: 'ordinary' },
    { accountManaged: false, mode: 'preflight', action: 'cancel' },
    { accountManaged: false, mode: 'preflight', action: 'repeat' },
    { accountManaged: false, mode: 'preflight', action: 'ordinary-during-health' },
  ])(
    'loads QR configuration and handles recovery: $accountManaged / $mode / $action',
    async ({ accountManaged, mode, action }) => {
      let authenticated = false
      let finishLogin = false
      let finishHealth: ((result: { status: string }) => void) | undefined
      mocks.requestLocalExecutor.mockImplementation(async (method, params) => {
        if (method === 'executor.plugins.store.list') {
          return {
            storePath: '/executor/capabilities/store/plugins',
            plugins: [
              {
                ...summary,
                packageId: summary.id,
                marketplace: 'wegent',
                pluginPath: `/executor/capabilities/store/plugins/60-wegent-${pluginName}-0.3.6`,
                cloudPluginId: 60,
                installedPluginId: 123,
              },
            ],
          }
        }
        if (method === 'codex.app_server_request') {
          if (params.method === 'plugin/installed') {
            return { marketplaces: [{ name: 'wegent', path: marketplacePath, plugins: [summary] }] }
          }
          if (params.method === 'plugin/read') {
            // The app-server requires a marketplace file, not the store directory.
            expect(params.params).toMatchObject({ marketplacePath, pluginName })
            return { plugin: { summary, skills: [], hooks: [], connectors: [] } }
          }
          throw new Error(`Unexpected app-server method: ${params.method}`)
        }
        if (method === 'executor.plugins.manifest.read') {
          expect(params).toEqual({ marketplacePath, pluginName })
          return {
            connectors: [
              {
                slug: 'weibo-wiki',
                authPolicy: 'on_install',
                localAuth,
                ...(accountManaged
                  ? {
                      accountAuth: {
                        protocolVersion: 1,
                        credentialType: 'oauth2',
                        adapter: 'scripts/account-auth.py',
                      },
                    }
                  : {}),
              },
            ],
          }
        }
        if (method === 'runtime.local_connector_auth.health') {
          if (action === 'ordinary-during-health') {
            return new Promise(resolve => {
              finishHealth = resolve
            })
          }
          return { status: authenticated ? 'ok' : 'need_login' }
        }
        if (method === 'runtime.local_connector_auth.start') {
          return {
            status: 'waiting_scan',
            sessionId: 'wiki-test-session',
            qrImage: { dataUrl: 'data:image/png;base64,dGVzdA==' },
          }
        }
        if (method === 'runtime.local_connector_auth.poll') {
          authenticated = finishLogin
          return { status: authenticated ? 'ok' : 'waiting_scan', sessionId: 'wiki-test-session' }
        }
        if (method === 'runtime.local_connector_auth.cancel') return { status: 'cancelled' }
        throw new Error(`Unexpected executor method: ${method}`)
      })
      const onSend = vi.fn()
      const onRetry = vi.fn(() => true)
      const message =
        mode === 'resume-done' ? { ...authMessage, status: 'done' as const } : authMessage
      render(
        <AuthConversation
          messages={mode === 'preflight' ? [] : [userMessage, message]}
          onSend={onSend}
          onRetry={onRetry}
        />
      )

      if (mode === 'preflight') fireEvent.click(screen.getByTestId('test-send'))

      if (action === 'ordinary-during-health') {
        await waitFor(() => expect(finishHealth).toBeDefined())
        fireEvent.click(screen.getByTestId('test-send-ordinary'))
        await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('ordinary message'))
        await act(async () => finishHealth!({ status: 'need_login' }))
        expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
        expect(onSend).toHaveBeenCalledExactlyOnceWith('ordinary message')
        expect(
          mocks.requestLocalExecutor.mock.calls.some(
            ([method]) => method === 'runtime.local_connector_auth.start'
          )
        ).toBe(false)
        return
      }

      expect(await screen.findByTestId('connector-auth-qr')).toHaveAttribute(
        'src',
        'data:image/png;base64,dGVzdA=='
      )
      expect(onSend).not.toHaveBeenCalled()
      expect(onRetry).not.toHaveBeenCalled()
      if (mode === 'preflight') {
        expect(screen.getByTestId('desktop-empty-composer-dock')).toContainElement(
          screen.getByTestId('connector-auth-card')
        )
      }
      expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
        'runtime.local_connector_auth.start',
        {
          pluginKey: pluginName,
          connectorSlug: 'weibo-wiki',
          pluginRoot: undefined,
          sessionId: undefined,
        }
      )

      if (action === 'ordinary' || action === 'cancel') {
        if (action === 'cancel') {
          fireEvent.click(screen.getByTestId('connector-auth-cancel'))
          expect(onSend).not.toHaveBeenCalled()
        }
        fireEvent.click(screen.getByTestId('test-send-ordinary'))
        await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('ordinary message'))
        expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument()
        expect(mocks.requestLocalExecutor).toHaveBeenCalledWith(
          'runtime.local_connector_auth.cancel',
          expect.objectContaining({ sessionId: 'wiki-test-session' })
        )
        finishLogin = true
        expect(onRetry).not.toHaveBeenCalled()
        return
      }
      if (action === 'repeat') {
        fireEvent.click(screen.getByTestId('test-send'))
        expect(onSend).not.toHaveBeenCalled()
        expect(
          mocks.requestLocalExecutor.mock.calls.filter(
            ([method]) => method === 'runtime.local_connector_auth.start'
          )
        ).toHaveLength(1)
      }
      finishLogin = true
      await waitFor(
        () => expect(screen.queryByTestId('connector-auth-card')).not.toBeInTheDocument(),
        { timeout: 2_000 }
      )
      if (mode !== 'resume') {
        expect(onSend).toHaveBeenCalledExactlyOnceWith(input)
        expect(onRetry).not.toHaveBeenCalled()
      } else {
        expect(onRetry).toHaveBeenCalledExactlyOnceWith(authMessage)
        expect(onSend).not.toHaveBeenCalled()
      }
      expect(
        mocks.requestLocalExecutor.mock.calls.some(([, params]) => params?.method === 'plugin/list')
      ).toBe(false)
      const api = createLocalCodexPluginApi()
      const membership = (await api.listInstalledPlugins()).items[0]
      const detailed = await api.readInstalledPluginDetail(membership)
      expect(detailed.spec.sourcePayload).toMatchObject({
        marketplacePath,
        managedByWegent: true,
        cloudPluginId: 60,
        cloudInstalledPluginId: 123,
      })
    }
  )
})
