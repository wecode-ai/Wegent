import { describe, expect, it } from 'vitest'
import { parseChatError } from '../../../packages/chat-core/src/chat-error'
import { describeMobileError, redactErrorDetails } from './errorPresentation'

describe('mobile error copy follows PC classification', () => {
  it('presents the reported model proxy failure without dumping transport details', () => {
    const raw =
      'unexpected status 502 Bad Gateway: {"detail":"Local model proxy request failed: error sending request for url (https://preview.example/api/runtime-work/llm-responses-proxy/responses)"}, url: http://127.0.0.1:60429/v1/codex-router/responses'
    expect(parseChatError(raw).type).toBe('model_service_connection_error')
    const error = describeMobileError(raw)
    expect(error.title).toBe('无法连接模型服务')
    expect(error.message).toBe('请检查网络或 VPN 连接后重试。')
    expect(error.details).toContain('502 Bad Gateway')
    expect(error.message).not.toMatch(/https?:|127\.0\.0|detail|502/)
  })

  it('keeps native exception stacks out of primary copy', () => {
    const raw =
      '远程设备不可用：fetch failed: UnexpectedException: The request timed out. (at ExpoModulesCore/Promise.swift:56)'
    const error = describeMobileError(raw)
    expect(error.title).toBe('连接未完成')
    expect(error.message).not.toContain('Promise.swift')
    expect(error.message).not.toContain('fetch')
    expect(error.details).toContain('Promise.swift:56')
  })

  it('keeps actionable human copy and the operation context', () => {
    expect(describeMobileError('请填写项目路径。', '无法创建项目')).toEqual({
      title: '无法创建项目',
      message: '请填写项目路径。',
    })
  })

  it('keeps unknown failures diagnosable without making up their cause', () => {
    const error = describeMobileError(new Error('Unexpected native failure 718'))
    expect(error.title).toBe('操作未完成')
    expect(error.message).not.toMatch(/网络|权限|账号/)
    expect(error.details).toBe('Unexpected native failure 718')
    expect(describeMobileError(null).details).toBeUndefined()
  })

  it('uses structured errors from the shared parser', () => {
    const error = describeMobileError({ error: { type: 'quota_exceeded', message: 'detail' } })
    expect(error.title).toBe('模型额度已用尽')
  })

  it.each([
    ['authentication_expired', '登录或凭据已失效'],
    ['skills_unmanaged_entries', 'Skills 目录与管理记录不一致'],
    ['skill_deploy_failed', '技能准备失败'],
    ['executor_start_failed', '执行器启动失败'],
    ['workspace_unavailable', '工作区不可用'],
    ['tool_execution_failed', '工具执行失败'],
    ['connector_unavailable', '连接器暂时不可用'],
    ['plugin_load_failed', '插件加载失败'],
    ['stream_protocol_error', '响应流解析失败'],
    ['internal_error', '平台内部错误'],
    ['storage_error', '对话数据读写失败'],
    ['dispatch_error', '任务调度失败'],
  ])('covers the shared %s classification', (code, title) => {
    const error = describeMobileError({ error: { code, message: 'detail' } })
    expect(error.title).toBe(title)
    expect(error.message).not.toBe('detail')
  })

  it('redacts URL credentials, query/fragment secrets, headers and structured keys', () => {
    const diagnostic =
      'https://user:pass@example.test/api?token=query-secret#fragment-secret ' +
      'Authorization: Bearer header-secret Cookie: session-secret ' +
      '{"access_token":"json-secret", "apiKey":"key-secret", "password":"password-secret"} ' +
      'sk-1234567890abcdefgh eyJabc.abc.signature'
    const redacted = redactErrorDetails(diagnostic)
    for (const secret of [
      'user:pass',
      'query-secret',
      'fragment-secret',
      'header-secret',
      'session-secret',
      'json-secret',
      'key-secret',
      'password-secret',
      'sk-1234567890abcdefgh',
      'eyJabc.abc.signature',
    ])
      expect(redacted).not.toContain(secret)
    expect(redacted).toContain('example.test/api')
    expect(redacted).toContain('[已隐藏]')
  })

  it('redacts complete cookie headers and escaped JSON secret values', () => {
    const raw =
      'Cookie: session=first-secret; auth=second-secret\n' +
      JSON.stringify({ password: 'prefix"escaped-secret' })
    const redacted = redactErrorDetails(raw)
    for (const secret of ['first-secret', 'second-secret', 'escaped-secret'])
      expect(redacted).not.toContain(secret)
  })
})
