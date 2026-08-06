import { describe, expect, test, vi } from 'vitest'
import {
  enrichInstalledPluginsForLocalAuth,
  extractConnectorAuthConnectorSlug,
  filterLocalRequirements,
  findLocalConnectorsForMessage,
  listLocalConnectors,
  messageNeedsConnectorPreflight,
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
    const items = listLocalConnectors([pluginWithLocalQr()])
    expect(items).toHaveLength(1)
    expect(items[0]?.connectorSlug).toBe('weibo-wiki')
  })

  test('finds connectors from plugin mention', () => {
    const items = findLocalConnectorsForMessage(
      '[$微博开放平台内部WIKI](plugin://weibo-api-wiki@wegent) 查 users/show',
      [pluginWithLocalQr()]
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.pluginKey).toBe('weibo-api-wiki')
  })

  test('only preflights explicit plugin or connector auth messages', () => {
    expect(messageNeedsConnectorPreflight('继续分析这个问题')).toBe(false)
    expect(
      messageNeedsConnectorPreflight(
        '[$微博开放平台内部WIKI](plugin://weibo-api-wiki@wegent) 查 users/show'
      )
    ).toBe(true)
    expect(
      messageNeedsConnectorPreflight(
        JSON.stringify({
          error: 'connector_auth_required',
          pluginKey: 'weibo-api-wiki',
          connectorSlug: 'weibo-wiki',
        })
      )
    ).toBe(true)
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

  test('resolves auth hint from structured connector_auth_required payload', () => {
    const hint = resolveLocalConnectorAuthHint(
      JSON.stringify({
        error: 'connector_auth_required',
        pluginKey: 'weibo-api-wiki',
        connectorSlug: 'weibo-wiki',
      })
    )
    expect(hint).toEqual({
      pluginKey: 'weibo-api-wiki',
      connectorSlug: 'weibo-wiki',
      displayName: 'weibo-api-wiki',
    })
  })

  test('resolves auth hint from connector slug prose without product-specific maps', () => {
    const hint = resolveLocalConnectorAuthHint(
      'Login expired. Host is starting weibo-wiki Connector authentication. Complete the QR card when it appears.'
    )
    expect(hint).toEqual({
      pluginKey: 'weibo-wiki',
      connectorSlug: 'weibo-wiki',
      displayName: 'weibo-wiki',
    })
  })

  test('matches installed plugins by connector slug when pluginKey is absent', () => {
    const items = filterLocalRequirements([pluginWithLocalQr()], {
      connectorSlug: 'weibo-wiki',
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.pluginKey).toBe('weibo-api-wiki')
  })

  test('does not list every local connector when identity is missing', () => {
    expect(filterLocalRequirements([pluginWithLocalQr()], {})).toEqual([])
    expect(
      filterLocalRequirements([pluginWithLocalQr()], {
        pluginKey: null,
        connectorSlug: null,
      })
    ).toEqual([])
  })

  test('does not treat generic connector query failures as auth resume', () => {
    expect(
      messageRequiresConnectorAuth(
        '账号信息显示你有 2 个公开项目，但 GitHub 连接器的项目搜索结果暂时返回 0 个项目。可能是项目索引同步延迟或连接器查询异常。'
      )
    ).toBe(false)
  })

  test('extracts connector slug and filters requirements', () => {
    const text = JSON.stringify({
      error: 'connector_auth_required',
      pluginKey: 'weibo-api-wiki',
      connectorSlug: 'weibo-wiki',
    })
    expect(extractConnectorAuthConnectorSlug(text)).toBe('weibo-wiki')
    const items = filterLocalRequirements([pluginWithLocalQr()], {
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
    const enriched = await enrichInstalledPluginsForLocalAuth([bare], readDetail)
    expect(readDetail).toHaveBeenCalledTimes(1)
    expect(listLocalConnectors(enriched)).toHaveLength(1)
  })

  test('lists browser oauth connectors', () => {
    const plugin = pluginWithLocalQr()
    plugin.spec.components.connectors![0]!.localAuth = {
      kind: 'browser_oauth',
      health: ['scripts/local-auth.sh', 'health'],
      start: ['scripts/local-auth.sh', 'login'],
      poll: [],
    }
    expect(listLocalConnectors([plugin])).toHaveLength(1)
  })
})
