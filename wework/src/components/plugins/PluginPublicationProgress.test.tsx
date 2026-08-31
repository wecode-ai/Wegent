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

    expect(screen.getByTestId('plugin-publication-progress-drawer')).toHaveTextContent('revision 2')
    expect(screen.getByTestId('plugin-publication-progress-drawer')).toHaveTextContent(
      'a'.repeat(64)
    )
    expect(screen.getByRole('link', { name: /打开 Draft MR/ })).toHaveAttribute(
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
      'Revision 2 · v1.2.0'
    )

    fireEvent.click(screen.getByTestId('plugin-publication-progress-withdraw'))
    expect(screen.getByTestId('plugin-publication-withdraw-confirmation')).toHaveTextContent(
      'Draft MR 会一并关闭'
    )
    fireEvent.click(screen.getByTestId('plugin-publication-withdraw-confirm'))
    expect(onWithdraw).toHaveBeenCalledTimes(1)
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
