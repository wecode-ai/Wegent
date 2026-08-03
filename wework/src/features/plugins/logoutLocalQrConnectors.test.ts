import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'

const logoutMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/local/localConnectorAuth', () => ({
  isLocalQrConnector: (connector: { localAuth?: { kind?: string; start?: string[] } | null }) =>
    Boolean(connector?.localAuth?.kind === 'local_qr' || connector?.localAuth?.start?.length),
  localConnectorAuthLogout: logoutMock,
}))

import { logoutLocalQrConnectorsForPlugin } from './logoutLocalQrConnectors'

function pluginWithConnectors(connectors: InstalledPlugin['spec']['components']['connectors']) {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'weibo-api-wiki', labels: { id: 61 } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'wegent-market',
        pluginKey: 'weibo-api-wiki',
      },
      displayName: '微博开放平台内部WIKI',
      description: '',
      installState: 'installed',
      enabled: true,
      manifest: {},
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcps: [],
        connectors,
        lsps: [],
        monitors: [],
        bins: [],
      },
      interface: null,
      packageRef: null,
    },
    status: { state: 'enabled' },
  } satisfies InstalledPlugin
}

describe('logoutLocalQrConnectorsForPlugin', () => {
  beforeEach(() => {
    logoutMock.mockReset()
    logoutMock.mockResolvedValue({ status: 'ok' })
  })

  test('logs out each local_qr connector', async () => {
    await logoutLocalQrConnectorsForPlugin(
      pluginWithConnectors([
        {
          slug: 'weibo-wiki',
          authPolicy: 'on_install',
          localAuth: {
            kind: 'local_qr',
            health: ['scripts/run-weibo-wiki.sh', 'health'],
            start: ['scripts/run-weibo-wiki.sh', 'auth', 'start'],
            poll: ['scripts/run-weibo-wiki.sh', 'auth', 'status'],
            logout: ['scripts/run-weibo-wiki.sh', 'auth', 'logout'],
          },
        },
      ])
    )

    expect(logoutMock).toHaveBeenCalledWith({
      pluginKey: 'weibo-api-wiki',
      connectorSlug: 'weibo-wiki',
      localAuth: expect.objectContaining({ kind: 'local_qr' }),
    })
  })

  test('ignores connectors without local QR auth', async () => {
    await logoutLocalQrConnectorsForPlugin(
      pluginWithConnectors([{ slug: 'github', authPolicy: 'on_install' }])
    )
    expect(logoutMock).not.toHaveBeenCalled()
  })

  test('continues when logout fails', async () => {
    logoutMock.mockRejectedValueOnce(new Error('logout failed'))
    await expect(
      logoutLocalQrConnectorsForPlugin(
        pluginWithConnectors([
          {
            slug: 'weibo-wiki',
            authPolicy: 'on_install',
            localAuth: {
              kind: 'local_qr',
              start: ['scripts/run-weibo-wiki.sh', 'auth', 'start'],
            },
          },
        ])
      )
    ).resolves.toBeUndefined()
  })
})
