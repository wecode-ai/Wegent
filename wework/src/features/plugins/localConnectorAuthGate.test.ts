import { describe, expect, test } from 'vitest'
import {
  connectorAuthMessageText,
  extractConnectorAuthConnectorSlug,
  latestConnectorAuthMessage,
  messageRequiresConnectorAuth,
  resolveConnectorAuthHint,
  resolveLocalConnectorAuthHint,
} from '@/features/plugins/localConnectorAuthGate'
import type { WorkbenchMessage } from '@/types/workbench'

describe('local connector authorization recovery messages', () => {
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
    ).toBe(false)
    expect(
      messageRequiresConnectorAuth(
        '目前尚未登录微博开放平台内部 WIKI。Wework 宿主正在通过 weibo-wiki Connector 发起身份认证。请在界面出现二维码卡片后完成扫码登录'
      )
    ).toBe(false)
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

  test.each([
    '- `pluginKey`: `github`\n- `connectorSlug`: `wework-github-cli`',
    '**pluginKey** : **github**\n**connectorSlug** : **wework-github-cli**',
    'pluginKey = github\nconnectorSlug = wework-github-cli',
  ])('resolves Markdown-formatted auth identity: %s', identity => {
    expect(resolveLocalConnectorAuthHint(`connector_auth_required\n${identity}`)).toEqual({
      pluginKey: 'github',
      connectorSlug: 'wework-github-cli',
      displayName: 'github',
    })
  })

  test('resolves a slug-only request as a cloud connector app', () => {
    expect(resolveConnectorAuthHint('connector_auth_required\nconnectorSlug=dingtalk_log')).toEqual(
      {
        pluginKey: null,
        connectorSlug: 'dingtalk_log',
        displayName: 'dingtalk_log',
      }
    )
    // Local plugin resolution stays strict and still requires both identities.
    expect(
      resolveLocalConnectorAuthHint('connector_auth_required\nconnectorSlug=dingtalk_log')
    ).toBeNull()
  })

  test('does not treat generic connector query failures as auth resume', () => {
    expect(
      messageRequiresConnectorAuth(
        '账号信息显示你有 2 个公开项目，但 GitHub 连接器的项目搜索结果暂时返回 0 个项目。可能是项目索引同步延迟或连接器查询异常。'
      )
    ).toBe(false)
  })

  test('only checks the latest assistant or system message for auth resume', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'assistant-old',
        role: 'assistant',
        content: 'weibo-wiki Connector needs login',
      },
      {
        id: 'user-latest',
        role: 'user',
        content: 'continue',
      },
      {
        id: 'assistant-latest',
        role: 'assistant',
        content: 'done',
      },
    ]

    expect(latestConnectorAuthMessage(messages)).toBeNull()
  })

  test('bounds connector auth text and keeps auth details at the end of large tool output', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-large-output',
      role: 'assistant',
      content: '',
      blocks: [
        {
          id: 'tool-1',
          type: 'tool',
          status: 'error',
          toolOutput: `${'x'.repeat(200_000)} connector_auth_required connectorSlug=weibo-wiki`,
          renderPayload: { content: 'y'.repeat(200_000) },
        },
      ],
    }

    const text = connectorAuthMessageText(message)

    expect(text.length).toBeLessThanOrEqual(64 * 1024 + 2)
    expect(text).toContain('connector_auth_required')
    expect(text).toContain('connectorSlug=weibo-wiki')
    expect(text).not.toContain('yyyy')
    expect(latestConnectorAuthMessage([message])?.message.id).toBe(message.id)
  })

  test('extracts structured auth fields without serializing arbitrary tool payloads', () => {
    const message: WorkbenchMessage = {
      id: 'assistant-structured-output',
      role: 'assistant',
      content: '',
      blocks: [
        {
          id: 'tool-1',
          type: 'tool',
          status: 'error',
          toolOutput: {
            error: 'connector_auth_required',
            pluginKey: 'weibo-api-wiki',
            connectorSlug: 'weibo-wiki',
            unrelated: 'x'.repeat(200_000),
          },
        },
      ],
    }

    const candidate = latestConnectorAuthMessage([message])

    expect(candidate?.text).toContain('pluginKey=weibo-api-wiki')
    expect(candidate?.text).toContain('connectorSlug=weibo-wiki')
    expect(candidate?.text).not.toContain('xxxx')
  })

  test.each([
    'need_login',
    'connector_auth_required pluginKey=weibo-api-wiki',
    'connector_auth_required connectorSlug=weibo-wiki',
    'Login expired. Host is starting weibo-wiki Connector authentication.',
    '以下是扫码登录配置：pluginKey=weibo-api-wiki connectorSlug=weibo-wiki',
  ])('requires both plugin and connector identities: %s', text => {
    expect(resolveLocalConnectorAuthHint(text)).toBeNull()
  })

  test('does not reopen an old authorization request after a new user message', () => {
    const messages: WorkbenchMessage[] = [
      {
        id: 'old-auth',
        role: 'assistant',
        content: 'connector_auth_required pluginKey=wiki connectorSlug=wiki',
      },
      { id: 'new-user', role: 'user', content: 'Ask a different question' },
    ]
    expect(latestConnectorAuthMessage(messages)).toBeNull()
  })

  test('preserves the explicit connector slug', () => {
    expect(extractConnectorAuthConnectorSlug('connectorSlug=wiki-login')).toBe('wiki-login')
  })
})
