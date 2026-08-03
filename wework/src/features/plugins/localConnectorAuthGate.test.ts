import { describe, expect, test } from 'vitest'
import {
  findLocalQrConnectorsForMessage,
  listLocalQrConnectors,
  messageRequiresConnectorAuth,
} from '@/features/plugins/localConnectorAuthGate'
import type { InstalledPlugin } from '@/types/api'

function pluginWithLocalQr(overrides?: Partial<InstalledPlugin>): InstalledPlugin {
  return {
    apiVersion: 'agent.wecode.io/v1',
    kind: 'InstalledPlugin',
    metadata: { name: 'weibo-api-wiki', namespace: 'wegent', labels: { id: '1' } },
    spec: {
      source: {
        type: 'marketplace',
        providerKey: 'marketplace',
        pluginKey: 'weibo-api-wiki',
      },
      origin: 'market',
      pluginId: 1,
      releaseId: 1,
      desiredVersion: '0.3.1',
      updatePolicy: 'manual',
      displayName: '微博开放平台内部WIKI',
      description: 'wiki',
      version: '0.3.1',
      installState: 'installed',
      enabled: true,
      components: {
        skills: [],
        commands: [],
        agents: [],
        apps: [],
        hooks: [],
        mcps: [],
        connectors: [
          {
            slug: 'weibo-wiki',
            authPolicy: 'on_install',
            localAuth: {
              kind: 'local_qr',
              health: ['scripts/run-weibo-wiki.sh', 'health'],
              start: ['scripts/run-weibo-wiki.sh', 'auth', 'start'],
              poll: ['scripts/run-weibo-wiki.sh', 'auth', 'status', '--wait-seconds', '0'],
            },
          },
        ],
        lsps: [],
        monitors: [],
        bins: [],
      },
      ...overrides?.spec,
    },
    ...overrides,
  } as InstalledPlugin
}

describe('localConnectorAuthGate', () => {
  test('lists local qr connectors', () => {
    const items = listLocalQrConnectors([pluginWithLocalQr()])
    expect(items).toHaveLength(1)
    expect(items[0]?.connectorSlug).toBe('weibo-wiki')
  })

  test('finds connectors from plugin mention', () => {
    const items = findLocalQrConnectorsForMessage(
      '[$微博开放平台内部WIKI](plugin://weibo-api-wiki@wegent) 查 users/show',
      [pluginWithLocalQr()]
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.pluginKey).toBe('weibo-api-wiki')
  })

  test('detects connector_auth_required payloads', () => {
    expect(
      messageRequiresConnectorAuth(
        JSON.stringify({ error: 'connector_auth_required', pluginKey: 'weibo-api-wiki' })
      )
    ).toBe(true)
    expect(messageRequiresConnectorAuth('all good')).toBe(false)
  })
})
