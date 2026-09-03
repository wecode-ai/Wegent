import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginPublishDialog } from './PluginPublishDialog'

const defaultProps = {
  pluginName: 'Dev Tools',
  pluginVersion: '1.2.0',
  publishing: false,
  onClose: vi.fn(),
  onPublish: vi.fn(),
  searchUsers: vi.fn(async () => []),
  searchGroups: vi.fn(async () => []),
}

describe('PluginPublishDialog', () => {
  test('offers exactly the selected member or department and enterprise intents', () => {
    render(<PluginPublishDialog {...defaultProps} />)

    const intents = screen.getAllByRole('radio')
    expect(intents).toHaveLength(2)
    expect(screen.getByRole('heading', { name: '分享与发布' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-share-intent-restricted')).toHaveTextContent('指定成员或部门')
    expect(screen.getByTestId('plugin-share-intent-restricted')).toBeEnabled()
    expect(screen.getByTestId('plugin-share-intent-continue')).toBeEnabled()
    expect(screen.getByTestId('plugin-share-intent-enterprise')).toHaveTextContent('全员可见')
    expect(screen.queryByText('组织内可见')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugin-share-enterprise-flow')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    expect(screen.getByTestId('plugin-share-enterprise-flow')).toHaveTextContent(
      '自动检查管理员审核代码审核发布'
    )
    expect(screen.getByTestId('plugin-share-enterprise-flow')).toHaveTextContent(
      '提交后不会立即向全员开放'
    )
  })

  test('supports arrow-key intent selection', () => {
    render(<PluginPublishDialog {...defaultProps} />)

    const restricted = screen.getByTestId('plugin-share-intent-restricted')
    const enterprise = screen.getByTestId('plugin-share-intent-enterprise')
    restricted.focus()
    fireEvent.keyDown(restricted, { key: 'ArrowDown' })
    expect(enterprise).toHaveFocus()
    expect(enterprise).toHaveAttribute('aria-checked', 'true')
  })

  test('saves a direct member and department share without review', async () => {
    const onPublish = vi.fn()
    const searchUsers = vi.fn(async () => [
      { id: 7, user_name: 'Alice', email: 'alice@example.com' },
    ])
    const searchGroups = vi.fn(async () => [{ id: 11, name: 'root', display_name: '微博研发部' }])
    render(
      <PluginPublishDialog
        {...defaultProps}
        onPublish={onPublish}
        searchUsers={searchUsers}
        searchGroups={searchGroups}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.change(screen.getByTestId('plugin-share-search'), { target: { value: 'Alice' } })
    fireEvent.click(await screen.findByTestId('plugin-share-user-7'))
    fireEvent.change(screen.getByTestId('plugin-share-search'), { target: { value: '研发' } })
    fireEvent.click(await screen.findByTestId('plugin-share-namespace-11'))
    fireEvent.click(screen.getByTestId('plugin-share-allow-copy'))
    fireEvent.click(screen.getByTestId('plugin-share-save-scope'))

    expect(onPublish).toHaveBeenCalledWith({
      intent: 'restricted',
      visibility: 'personal',
      targets: [
        { entityType: 'user', entityId: '7', displayName: 'Alice' },
        { entityType: 'namespace', entityId: '11', displayName: '微博研发部' },
      ],
      allowCopy: true,
    })
  })

  test('collects an immutable enterprise version and risk declaration in three steps', () => {
    const onPublish = vi.fn()
    render(<PluginPublishDialog {...defaultProps} onPublish={onPublish} />)

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    expect(screen.getByTestId('plugin-publication-step-version')).toHaveTextContent('v1.2.0')

    const nextRisk = screen.getByTestId('plugin-publication-next-risk')
    expect(nextRisk).toBeDisabled()
    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '支持项目日志检索' },
    })
    fireEvent.click(nextRisk)

    expect(screen.getByTestId('plugin-publication-step-risk')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('plugin-publication-risk-network'))
    fireEvent.change(screen.getByTestId('plugin-publication-external-domains'), {
      target: { value: 'API.EXAMPLE.COM, logs.example.com' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-risk-command'))
    fireEvent.change(screen.getByTestId('plugin-publication-command-examples'), {
      target: { value: 'node scripts/check.js' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-risk-credentials'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-application'))
    fireEvent.change(screen.getByTestId('plugin-publication-application-permissions'), {
      target: { value: 'GitLab OAuth: read_api' },
    })
    fireEvent.change(screen.getByTestId('plugin-publication-test-notes'), {
      target: { value: 'Windows 与 macOS 基础场景均通过' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-confirm'))

    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'api.example.com, logs.example.com'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'node scripts/check.js'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'GitLab OAuth: read_api'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'Windows 与 macOS 基础场景均通过'
    )
    const submit = screen.getByTestId('plugin-publication-submit')
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByTestId('plugin-publication-declaration'))
    fireEvent.click(submit)

    expect(onPublish).toHaveBeenCalledWith({
      intent: 'enterprise',
      visibility: 'workspace',
      targets: [],
      allowCopy: false,
      operationAttemptId: expect.any(String),
      releaseNotes: '支持项目日志检索',
      testNotes: 'Windows 与 macOS 基础场景均通过',
      riskDeclaration: {
        externalNetworkAccess: true,
        externalDomains: ['api.example.com', 'logs.example.com'],
        executesCommands: true,
        commandExamples: ['node scripts/check.js'],
        readsOrWritesLocalFiles: false,
        usesCredentials: true,
        applicationPermissions: ['GitLab OAuth: read_api'],
        additionalNotes: '',
      },
    })
  })

  test('dismisses the enterprise drawer only from its backdrop when idle', () => {
    const onClose = vi.fn()
    const view = render(<PluginPublishDialog {...defaultProps} onClose={onClose} />)

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.click(screen.getByTestId('plugin-publication-drawer'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('plugin-publication-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)

    view.rerender(<PluginPublishDialog {...defaultProps} onClose={onClose} publishing />)
    fireEvent.click(screen.getByTestId('plugin-publication-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('keeps release-note focus and value while typing', () => {
    render(<PluginPublishDialog {...defaultProps} />)

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    const releaseNotes = screen.getByTestId('plugin-publication-release-notes')
    releaseNotes.focus()
    fireEvent.change(releaseNotes, { target: { value: '支' } })
    expect(screen.getByTestId('plugin-publication-next-risk')).toBeEnabled()

    fireEvent.change(releaseNotes, { target: { value: '支持' } })
    fireEvent.change(releaseNotes, { target: { value: '支持项目' } })
    fireEvent.change(releaseNotes, { target: { value: '支持项目日志检索' } })

    expect(releaseNotes).toHaveFocus()
    expect(releaseNotes).toHaveValue('支持项目日志检索')

    fireEvent.click(screen.getByTestId('plugin-publication-next-risk'))
    fireEvent.click(screen.getByTestId('plugin-publication-back'))
    expect(screen.getByTestId('plugin-publication-release-notes')).toHaveValue('支持项目日志检索')

    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '   ' },
    })
    expect(screen.getByTestId('plugin-publication-next-risk')).toBeDisabled()
  })

  test('does not restore trigger focus when callback props change', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const view = render(<PluginPublishDialog {...defaultProps} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))

    const releaseNotes = screen.getByTestId('plugin-publication-release-notes')
    releaseNotes.focus()
    expect(releaseNotes).toHaveFocus()

    view.rerender(<PluginPublishDialog {...defaultProps} onClose={vi.fn()} error="后台状态刷新" />)

    expect(releaseNotes).toHaveFocus()
    trigger.remove()
  })

  test('keeps risk-step focus and values while typing', () => {
    render(<PluginPublishDialog {...defaultProps} />)

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '版本说明' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-risk'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-network'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-command'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-application'))

    const domains = screen.getByTestId('plugin-publication-external-domains')
    const commands = screen.getByTestId('plugin-publication-command-examples')
    const permissions = screen.getByTestId('plugin-publication-application-permissions')
    const testNotes = screen.getByTestId('plugin-publication-test-notes')
    const additionalNotes = screen.getByTestId('plugin-publication-additional-notes')

    fireEvent.change(domains, { target: { value: 'a' } })
    fireEvent.change(commands, { target: { value: 'n' } })
    fireEvent.change(permissions, { target: { value: 'g' } })
    fireEvent.change(testNotes, { target: { value: '通' } })

    additionalNotes.focus()
    fireEvent.change(domains, { target: { value: 'API.EXAMPLE.COM' } })
    fireEvent.change(commands, { target: { value: 'node scripts/check.js' } })
    fireEvent.change(permissions, { target: { value: 'GitLab OAuth: read_api' } })
    fireEvent.change(testNotes, { target: { value: '通过 Windows 与 macOS 测试' } })
    fireEvent.change(additionalNotes, { target: { value: '补充风险说明' } })

    expect(additionalNotes).toHaveFocus()
    expect(screen.getByTestId('plugin-publication-next-confirm')).toBeEnabled()

    fireEvent.click(screen.getByTestId('plugin-publication-next-confirm'))
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'api.example.com'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'node scripts/check.js'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      'GitLab OAuth: read_api'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent(
      '通过 Windows 与 macOS 测试'
    )
    expect(screen.getByTestId('plugin-publication-step-confirm')).toHaveTextContent('补充风险说明')

    fireEvent.click(screen.getByTestId('plugin-publication-back'))
    expect(screen.getByTestId('plugin-publication-external-domains')).toHaveValue('API.EXAMPLE.COM')
    expect(screen.getByTestId('plugin-publication-test-notes')).toHaveValue(
      '通过 Windows 与 macOS 测试'
    )
    expect(screen.getByTestId('plugin-publication-additional-notes')).toHaveValue('补充风险说明')
  })

  test('requires non-blank test notes without imposing a minimum length', () => {
    render(<PluginPublishDialog {...defaultProps} />)

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '版本说明' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-risk'))

    const testNotes = screen.getByTestId('plugin-publication-test-notes')
    const next = screen.getByTestId('plugin-publication-next-confirm')
    expect(next).toBeDisabled()

    fireEvent.change(testNotes, { target: { value: '   ' } })
    expect(testNotes).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByTestId('plugin-publication-test-notes-help')).toHaveTextContent(
      '测试说明不能为空'
    )
    expect(next).toBeDisabled()

    fireEvent.change(testNotes, { target: { value: '测过了' } })
    expect(testNotes).toHaveAttribute('aria-invalid', 'false')
    expect(next).toBeEnabled()
  })

  test('preserves an active risk-step input across parent rerenders', () => {
    const view = render(<PluginPublishDialog {...defaultProps} />)

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '版本说明' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-risk'))

    const input = screen.getByTestId('plugin-publication-additional-notes')
    input.focus()
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '中文输入中' } })

    view.rerender(<PluginPublishDialog {...defaultProps} error="后台状态刷新" />)

    expect(screen.getByTestId('plugin-publication-additional-notes')).toBe(input)
    expect(input).toHaveFocus()
    expect(input).toHaveValue('中文输入中')
    fireEvent.compositionEnd(input, { data: '中文输入中' })
  })

  test('opens the active request instead of creating a duplicate', () => {
    const onViewPublication = vi.fn()
    render(
      <PluginPublishDialog
        {...defaultProps}
        activePublication={{
          id: 82,
          version: '1.2.0',
          status: '管理员审核中',
          canCreateRevision: false,
        }}
        onViewPublication={onViewPublication}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    expect(screen.getByTestId('plugin-share-intent-continue')).toHaveTextContent('查看申请进度')
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))

    expect(onViewPublication).toHaveBeenCalledWith(82)
    expect(screen.queryByTestId('plugin-publication-drawer')).not.toBeInTheDocument()
  })

  test('starts a new immutable revision after a request is returned', () => {
    const onViewPublication = vi.fn()
    render(
      <PluginPublishDialog
        {...defaultProps}
        activePublication={{
          id: 82,
          version: '1.1.0',
          status: '已退回修改',
          canCreateRevision: true,
        }}
        onViewPublication={onViewPublication}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    expect(screen.getByTestId('plugin-share-intent-enterprise')).toHaveTextContent(
      '本次 v1.2.0 · 上次申请 v1.1.0 已退回修改'
    )
    expect(screen.getByTestId('plugin-share-intent-continue')).toHaveTextContent('提交新修订版')
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))

    expect(onViewPublication).not.toHaveBeenCalled()
    expect(screen.getByTestId('plugin-publication-step-version')).toHaveTextContent('v1.2.0')
  })

  test('shows the current personal version instead of a withdrawn request version', () => {
    render(
      <PluginPublishDialog
        {...defaultProps}
        pluginVersion="0.2.0+codex.20260902140548"
        activePublication={{
          id: 82,
          version: '0.1.0',
          status: 'withdrawn',
          canCreateRevision: true,
        }}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))

    expect(screen.getByTestId('plugin-share-intent-enterprise')).toHaveTextContent(
      '本次 v0.2.0+codex.20260902140548 · 上次申请 v0.1.0 已撤回'
    )
    expect(screen.getByTestId('plugin-share-intent-continue')).toHaveTextContent('提交新修订版')
  })

  test('starts a new request when a newer personal version follows a published request', () => {
    const onViewPublication = vi.fn()
    render(
      <PluginPublishDialog
        {...defaultProps}
        activePublication={{
          id: 82,
          version: '1.1.0',
          status: 'published',
          canCreateRevision: false,
        }}
        onViewPublication={onViewPublication}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    expect(screen.getByTestId('plugin-share-intent-continue')).toHaveTextContent('继续填写发布申请')
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))

    expect(onViewPublication).not.toHaveBeenCalled()
    expect(screen.getByTestId('plugin-publication-step-version')).toHaveTextContent('v1.2.0')
  })

  test('requires domains when external network access is declared', () => {
    render(<PluginPublishDialog {...defaultProps} />)
    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '网络能力更新' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-risk'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-network'))
    fireEvent.change(screen.getByTestId('plugin-publication-test-notes'), {
      target: { value: '基础测试通过' },
    })

    expect(screen.getByTestId('plugin-publication-next-confirm')).toBeDisabled()
  })

  test('does not submit hidden risk details after their declarations are disabled', () => {
    const onPublish = vi.fn()
    render(<PluginPublishDialog {...defaultProps} onPublish={onPublish} />)
    fireEvent.click(screen.getByTestId('plugin-share-intent-enterprise'))
    fireEvent.click(screen.getByTestId('plugin-share-intent-continue'))
    fireEvent.change(screen.getByTestId('plugin-publication-release-notes'), {
      target: { value: '风险字段清理' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-risk'))

    fireEvent.click(screen.getByTestId('plugin-publication-risk-network'))
    fireEvent.change(screen.getByTestId('plugin-publication-external-domains'), {
      target: { value: 'stale.example.com' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-risk-network'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-command'))
    fireEvent.change(screen.getByTestId('plugin-publication-command-examples'), {
      target: { value: 'bash stale.sh' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-risk-command'))
    fireEvent.click(screen.getByTestId('plugin-publication-risk-application'))
    fireEvent.change(screen.getByTestId('plugin-publication-application-permissions'), {
      target: { value: 'mail.read' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-risk-application'))
    fireEvent.change(screen.getByTestId('plugin-publication-test-notes'), {
      target: { value: '基础测试通过' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-next-confirm'))
    fireEvent.click(screen.getByTestId('plugin-publication-declaration'))
    fireEvent.click(screen.getByTestId('plugin-publication-submit'))

    expect(onPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        riskDeclaration: expect.objectContaining({
          externalNetworkAccess: false,
          externalDomains: [],
          executesCommands: false,
          commandExamples: [],
          applicationPermissions: [],
        }),
      })
    )
  })

  test('offers share recovery when version conflict recovery is enabled', async () => {
    const onShareRecovery = vi.fn()
    render(
      <PluginPublishDialog
        {...defaultProps}
        error="该版本已存在，请先在插件清单中提升 version 后再发布。"
        shareRecoveryLabel="去分享成员"
        onShareRecovery={onShareRecovery}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publish-share-recovery'))
    await waitFor(() => expect(onShareRecovery).toHaveBeenCalledTimes(1))
  })
})
