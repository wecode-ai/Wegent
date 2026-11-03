import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
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
