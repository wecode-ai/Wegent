import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { PluginPublicationRequestItem } from '@/types/api'
import { PluginPublicationProgressCard } from './PluginPublicationProgressCard'
import { PluginPublicationProgressDrawer } from './PluginPublicationProgressDrawer'

function createPublication(
  overrides: Partial<PluginPublicationRequestItem> = {}
): PluginPublicationRequestItem {
  const revision = {
    id: 91,
    number: 2,
    requestedVersion: '1.2.0',
    snapshotSha256: 'a'.repeat(64),
    status: 'admin_review' as const,
    releaseNotes: '支持项目日志检索',
    testNotes: 'Windows 与 macOS 基础场景均通过',
    createdAt: '2026-08-29T08:59:00Z',
    declarations: [],
    manifest: {},
    packageEntries: ['dev-tools/.codex-plugin/plugin.json'],
    packageEntryCount: 1,
    packageEntriesTruncated: false,
    capabilities: ['skill:dev-tools'],
  }
  return {
    id: 82,
    pluginId: 101,
    pluginName: 'Dev Tools',
    pluginSlug: 'dev-tools',
    requestedVersion: '1.2.0',
    submitter: { id: 7, userName: 'Alice', email: 'alice@example.com' },
    currentRevision: 2,
    stage: 'administrator_review',
    status: 'admin_review',
    riskLevel: 'low',
    blockerCount: 0,
    warningCount: 1,
    gitlabStatus: 'running',
    waitingDurationSeconds: 300,
    submittedAt: '2026-08-29T09:00:00Z',
    revision,
    revisions: [revision],
    checks: [
      {
        id: 1,
        checkCode: 'package_scan',
        severity: 'blocker',
        status: 'passed',
        title: '包结构与风险扫描',
        summary: '检查通过',
        evidence: [],
        jobUrl: 'https://git.example.com/pipeline/9',
        acknowledgementRequired: false,
        acknowledged: false,
      },
    ],
    events: [
      {
        id: 2,
        eventType: 'administrator_review_started',
        actorType: 'admin',
        actorName: 'Reviewer',
        message: '管理员开始审核',
        createdAt: '2026-08-29T09:05:00Z',
      },
    ],
    gitlab: {
      sourceBranch: 'publication/dev-tools/1.2.0-r2',
      mergeRequestIid: 18,
      mergeRequestUrl: 'https://git.example.com/mr/18',
      pipelineUrl: 'https://git.example.com/pipeline/9',
      pipelineStatus: 'running',
    },
    actionEligibility: {
      canWithdraw: true,
      canCreateRevision: false,
      canViewEnterprisePlugin: false,
      canReturn: false,
      canAccept: false,
      canReconcile: false,
      blockedReasons: [],
    },
    createdAt: '2026-08-29T08:59:00Z',
    updatedAt: '2026-08-29T09:05:00Z',
    ...overrides,
  }
}

describe('Plugin publication progress', () => {
  test('shows the five frozen stages and routes to request detail', () => {
    const onView = vi.fn()
    render(<PluginPublicationProgressCard publication={createPublication()} onView={onView} />)

    expect(screen.getByTestId('plugin-publication-card-82')).toHaveTextContent('提交申请')
    expect(screen.getByTestId('plugin-publication-card-82')).toHaveTextContent('自动检查')
    expect(screen.getByTestId('plugin-publication-card-82')).toHaveTextContent('管理员审核')
    expect(screen.getByTestId('plugin-publication-card-82')).toHaveTextContent('代码审核')
    expect(screen.getByTestId('plugin-publication-card-82')).toHaveTextContent('发布')
    fireEvent.click(screen.getByTestId('plugin-publication-view-progress-82'))
    expect(onView).toHaveBeenCalledTimes(1)
  })

  test('shows immutable revision evidence and confirms withdrawal inline', () => {
    const onWithdraw = vi.fn()
    render(
      <PluginPublicationProgressDrawer
        publication={createPublication()}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onWithdraw={onWithdraw}
      />
    )

    expect(screen.getByTestId('plugin-publication-progress-drawer')).toHaveTextContent('修订版 2')
    expect(screen.getByTestId('plugin-publication-progress-drawer')).toHaveTextContent(
      'a'.repeat(64)
    )
    expect(screen.getByRole('link', { name: /打开 MR/ })).toHaveAttribute(
      'href',
      'https://git.example.com/mr/18'
    )
    expect(screen.getByTestId('plugin-publication-progress-checks')).toHaveTextContent(
      '包结构与风险扫描'
    )
    expect(screen.getByTestId('plugin-publication-progress-checks')).toHaveTextContent(
      'package_scan'
    )
    expect(screen.getByTestId('plugin-publication-revision-history')).toHaveTextContent(
      '修订版 2 · v1.2.0'
    )
    expect(screen.getByTestId('plugin-publication-progress-events')).toHaveTextContent(
      '2026-08-29 17:05:00'
    )
    expect(screen.getByTestId('plugin-publication-progress-events')).not.toHaveTextContent(
      '2026-08-29T09:05:00Z'
    )

    const withdrawButton = screen.getByTestId('plugin-publication-progress-withdraw')
    expect(withdrawButton).toHaveClass('border-red-500/40', 'text-red-600')
    expect(withdrawButton.querySelector('.lucide-circle-x')).toBeInTheDocument()
    fireEvent.click(withdrawButton)
    expect(screen.getByTestId('plugin-publication-withdraw-confirmation')).toHaveTextContent(
      'MR 会一并关闭'
    )
    const confirmButton = screen.getByTestId('plugin-publication-withdraw-confirm')
    expect(confirmButton).toHaveClass('bg-red-600', 'text-white')
    fireEvent.click(confirmButton)
    expect(onWithdraw).toHaveBeenCalledTimes(1)
  })

  test('renders withdrawal as a distinct danger action on the progress card', () => {
    render(
      <PluginPublicationProgressCard
        publication={createPublication()}
        onView={vi.fn()}
        onWithdraw={vi.fn()}
      />
    )

    const withdrawButton = screen.getByTestId('plugin-publication-withdraw-82')
    expect(withdrawButton).toHaveClass('border-red-500/40', 'text-red-600')
    expect(withdrawButton.querySelector('.lucide-circle-x')).toBeInTheDocument()
  })

  test('does not expose withdrawal after publication', () => {
    render(
      <PluginPublicationProgressCard
        publication={createPublication({
          status: 'published',
          stage: 'release',
          actionEligibility: {
            canWithdraw: false,
            canCreateRevision: false,
            canViewEnterprisePlugin: true,
            canReturn: false,
            canAccept: false,
            canReconcile: false,
            blockedReasons: [],
          },
        })}
        onView={vi.fn()}
        onWithdraw={vi.fn()}
      />
    )

    expect(screen.queryByTestId('plugin-publication-withdraw-82')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-publication-view-progress-82')).toHaveTextContent(
      '查看企业版本'
    )
  })

  test('shows textual check evidence even when no CI job link is available', () => {
    render(
      <PluginPublicationProgressDrawer
        publication={createPublication({
          checks: [
            {
              id: 9,
              checkCode: 'risk_scan',
              severity: 'warning',
              status: 'warning',
              title: '风险扫描',
              summary: '发现待确认项',
              evidence: ['检测到外部域名 api.example.com'],
              jobUrl: null,
              acknowledgementRequired: true,
              acknowledged: false,
            },
          ],
        })}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(screen.getByTestId('plugin-publication-check-evidence-list-9')).toHaveTextContent(
      '检测到外部域名 api.example.com'
    )
    expect(screen.queryByTestId('plugin-publication-check-evidence-9')).not.toBeInTheDocument()
  })

  test('offers a new revision after administrator changes are requested', () => {
    const onCreateRevision = vi.fn()
    render(
      <PluginPublicationProgressDrawer
        publication={createPublication({
          status: 'changes_requested',
          actionEligibility: {
            canWithdraw: true,
            canCreateRevision: true,
            canViewEnterprisePlugin: false,
            canReturn: false,
            canAccept: false,
            canReconcile: false,
            blockedReasons: [],
          },
        })}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onCreateRevision={onCreateRevision}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publication-progress-create-revision'))
    expect(onCreateRevision).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('plugin-publication-progress-create-revision')).toHaveTextContent(
      '修复并重新提交'
    )
  })

  test('shows Pipeline failure details and MR closure context without GitLab access', () => {
    render(
      <PluginPublicationProgressDrawer
        publication={createPublication({
          status: 'code_changes_requested',
          events: [
            {
              id: 31,
              eventType: 'gitlab.pipeline_failed',
              actorType: 'pipeline',
              message: 'GitLab Pipeline did not pass',
              failureDetails: [
                {
                  jobName: 'wework-linux',
                  stage: 'verify',
                  status: 'failed',
                  reason: 'script_failure',
                  jobUrl: 'https://git.example.com/jobs/301',
                },
              ],
              createdAt: '2026-08-29T09:05:00Z',
            },
            {
              id: 32,
              eventType: 'gitlab.merge_request_closed',
              actorType: 'gitlab',
              actorName: 'Code Reviewer',
              message: 'GitLab merge request was closed without a supplied reason',
              createdAt: '2026-08-29T09:10:00Z',
            },
          ],
          actionEligibility: {
            canWithdraw: true,
            canCreateRevision: true,
            canViewEnterprisePlugin: false,
            canReturn: false,
            canAccept: false,
            canReconcile: false,
            blockedReasons: [],
          },
        })}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onCreateRevision={vi.fn()}
      />
    )

    expect(screen.getByTestId('plugin-publication-event-failures-31')).toHaveTextContent(
      'wework-linux · verify'
    )
    expect(screen.getByTestId('plugin-publication-event-failures-31')).toHaveTextContent(
      '任务脚本执行失败'
    )
    expect(screen.getByRole('link', { name: /查看失败任务/ })).toHaveAttribute(
      'href',
      'https://git.example.com/jobs/301'
    )
    expect(screen.getByTestId('plugin-publication-progress-events')).toHaveTextContent(
      'MR 已由 Code Reviewer 关闭；GitLab 未提供关闭原因'
    )
    expect(screen.getByTestId('plugin-publication-progress-create-revision')).toHaveTextContent(
      '修复并重新提交'
    )
  })

  test('offers repair and resubmit as the primary card action', () => {
    const onCreateRevision = vi.fn()
    render(
      <PluginPublicationProgressCard
        publication={createPublication({
          status: 'changes_requested',
          actionEligibility: {
            canWithdraw: true,
            canCreateRevision: true,
            canViewEnterprisePlugin: false,
            canReturn: false,
            canAccept: false,
            canReconcile: false,
            blockedReasons: [],
          },
        })}
        onView={vi.fn()}
        onCreateRevision={onCreateRevision}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publication-create-revision-82'))
    expect(onCreateRevision).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('plugin-publication-create-revision-82')).toHaveTextContent(
      '修复并重新提交'
    )
  })

  test('switches between request and revision history with full evidence loading callbacks', () => {
    const onSelectRequest = vi.fn()
    const onSelectRevision = vi.fn()
    const current = createPublication({
      revisions: [
        createPublication().revision,
        {
          ...createPublication().revision,
          id: 90,
          number: 1,
          requestedVersion: '1.1.0',
          snapshotSha256: 'b'.repeat(64),
          status: 'changes_requested',
        },
      ],
    })
    const previous = createPublication({
      id: 81,
      requestedVersion: '1.1.0',
      status: 'published',
      updatedAt: '2026-08-28T09:05:00Z',
    })

    render(
      <PluginPublicationProgressDrawer
        publication={current}
        requestHistory={[current, previous]}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSelectRequest={onSelectRequest}
        onSelectRevision={onSelectRevision}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publication-request-81'))
    fireEvent.click(screen.getByTestId('plugin-publication-revision-1'))
    expect(onSelectRequest).toHaveBeenCalledWith(81)
    expect(onSelectRevision).toHaveBeenCalledWith(1)
  })

  test('closes the progress drawer with Escape', () => {
    const onClose = vi.fn()
    render(
      <PluginPublicationProgressDrawer
        publication={createPublication()}
        onClose={onClose}
        onRefresh={vi.fn()}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('dismisses the progress drawer only from its backdrop when idle', () => {
    const onClose = vi.fn()
    const view = render(
      <PluginPublicationProgressDrawer
        publication={createPublication()}
        onClose={onClose}
        onRefresh={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publication-progress-drawer'))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('plugin-publication-progress-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)

    view.rerender(
      <PluginPublicationProgressDrawer
        publication={createPublication()}
        loading
        onClose={onClose}
        onRefresh={vi.fn()}
      />
    )
    fireEvent.click(screen.getByTestId('plugin-publication-progress-overlay'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('routes a published request to the enterprise marketplace version', () => {
    const onViewEnterprise = vi.fn()
    render(
      <PluginPublicationProgressDrawer
        publication={createPublication({
          enterprisePluginId: 303,
          status: 'published',
          stage: 'release',
          actionEligibility: {
            canWithdraw: false,
            canCreateRevision: false,
            canViewEnterprisePlugin: true,
            canReturn: false,
            canAccept: false,
            canReconcile: false,
            blockedReasons: [],
          },
        })}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onViewEnterprise={onViewEnterprise}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publication-progress-view-enterprise'))
    expect(onViewEnterprise).toHaveBeenCalledTimes(1)
  })
})
