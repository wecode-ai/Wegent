import { describe, expect, test } from 'vitest'
import { humanizeMarketplaceInstallError } from './marketplaceInstallError'

const t = (_key: string, defaultValue: string) => defaultValue

describe('humanizeMarketplaceInstallError', () => {
  test('maps admin-disabled remote plugins', () => {
    expect(
      humanizeMarketplaceInstallError(
        'codex_app_server_request_failed: remote plugin plugin_connector_1p_95d39881713c8191931482a62d6edff9 is disabled by admin',
        t
      )
    ).toBe('该插件已被 ChatGPT / Codex 工作区管理员禁用，请联系管理员开通后再安装。')
  })

  test('maps ChatGPT authentication failures', () => {
    expect(
      humanizeMarketplaceInstallError(
        'chatgpt authentication required for remote plugin catalog',
        t
      )
    ).toBe('安装该远程插件需要先登录 ChatGPT / Codex 账号。')
  })

  test('strips the executor prefix from other failures', () => {
    expect(humanizeMarketplaceInstallError('codex_app_server_request_failed: boom', t)).toBe('boom')
  })
})
