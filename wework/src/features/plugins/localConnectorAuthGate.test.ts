import { describe, expect, it } from 'vitest'
import type { WorkbenchMessage } from '@/types/workbench'
import { latestConnectorAuthMessage } from './localConnectorAuthGate'

const message = (content: string, fields: Partial<WorkbenchMessage> = {}): WorkbenchMessage => ({
  id: 'reply',
  role: 'assistant',
  status: 'done',
  content,
  createdAt: '2026-11-23T00:00:00.000Z',
  ...fields,
})

describe('conversation connector authorization', () => {
  it.each([
    'The parser reads `connector_auth_required`, `pluginKey`: `hint.pluginKey` and `connectorSlug`: `account`.',
    'Example:\n\n```text\nconnector_auth_required\npluginKey=example\nconnectorSlug=account\n```',
    'connector_auth_required\n\nThe relevant code uses:\n\npluginKey=example\nconnectorSlug=account',
    'connector_auth_required\npluginKey=example',
  ])('ignores prose, code examples and incomplete records', content => {
    expect(latestConnectorAuthMessage([message(content)])).toBeNull()
  })

  it('does not combine a marker and identity from different sources', () => {
    expect(
      latestConnectorAuthMessage([
        message('pluginKey=example\nconnectorSlug=account', { error: 'need_login' }),
      ])
    ).toBeNull()
  })

  it('recognizes adjacent Markdown protocol fields', () => {
    const content =
      '需要登录。\n\n- `connector_auth_required`\n- `pluginKey`: `github`\n- `connectorSlug`: `wework-github-cli`'
    expect(latestConnectorAuthMessage([message(content)])?.hint).toMatchObject({
      pluginKey: 'github',
      connectorSlug: 'wework-github-cli',
    })
  })

  it('recognizes structured MCP authorization errors with no local plugin', () => {
    const error = JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'connector_auth_required',
            connectorSlug: 'dingtalk_docs',
          }),
        },
      ],
      isError: true,
    })
    expect(
      latestConnectorAuthMessage([message('请连接钉钉文档。', { error })])?.hint
    ).toMatchObject({
      pluginKey: null,
      connectorSlug: 'dingtalk_docs',
    })
  })
})
