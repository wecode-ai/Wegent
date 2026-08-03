import { describe, expect, test, vi } from 'vitest'
import {
  enrichInstalledPluginsForLocalQr,
  extractConnectorAuthConnectorSlug,
  filterLocalQrRequirements,
  findLocalQrConnectorsForMessage,
  listLocalQrConnectors,
  messageRequiresConnectorAuth,
  resolveLocalConnectorAuthHint,
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
    expect(
      messageRequiresConnectorAuth(
        '微博开放平台内部 WIKI 的登录会话已失效，需要通过 Wework 主机连接器重新认证。界面会显示二维码登录卡片'
      )
    ).toBe(true)
    expect(
      messageRequiresConnectorAuth(
        '目前尚未登录微博开放平台内部 WIKI。Wework 宿主正在通过 weibo-wiki Connector 发起身份认证。请在界面出现二维码卡片后完成扫码登录'
      )
    ).toBe(true)
    expect(messageRequiresConnectorAuth('all good')).toBe(false)
  })

  test('resolves auth hint from paraphrased assistant text', () => {
    const hint = resolveLocalConnectorAuthHint(
      '目前尚未登录微博开放平台内部 WIKI。Wework 宿主正在通过 weibo-wiki Connector 发起身份认证。请在界面出现二维码卡片后完成扫码登录'
    )
    expect(hint).toEqual({
      pluginKey: 'weibo-api-wiki',
      connectorSlug: 'weibo-wiki',
      displayName: '微博开放平台内部WIKI',
    })
  })

  test('extracts connector slug and filters requirements', () => {
    const text = JSON.stringify({
      error: 'connector_auth_required',
      pluginKey: 'weibo-api-wiki',
      connectorSlug: 'weibo-wiki',
    })
    expect(extractConnectorAuthConnectorSlug(text)).toBe('weibo-wiki')
    const items = filterLocalQrRequirements([pluginWithLocalQr()], {
      pluginKey: 'weibo-api-wiki',
      connectorSlug: 'weibo-wiki',
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.connectorSlug).toBe('weibo-wiki')
  })

  test('enriches installed plugins that omit localAuth connectors', async () => {
    const bare = pluginWithLocalQr({
      spec: {
        ...pluginWithLocalQr().spec,
        components: {
          skills: [],
          commands: [],
          agents: [],
          apps: [],
          hooks: [],
          mcps: [],
          connectors: [],
          lsps: [],
          monitors: [],
          bins: [],
        },
      },
    })
    const readDetail = vi.fn(async () => pluginWithLocalQr())
    const enriched = await enrichInstalledPluginsForLocalQr([bare], readDetail)
    expect(readDetail).toHaveBeenCalledTimes(1)
    expect(listLocalQrConnectors(enriched)).toHaveLength(1)
  })
})
