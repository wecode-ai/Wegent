// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  adminPluginPublicationApis,
  type AdminPluginPublicationRequestDetail,
} from '@/apis/admin-plugin-publications'
import PluginPublicationReviewDrawer from '@/features/admin/components/PluginPublicationReviewDrawer'

jest.mock('@/apis/admin-plugin-publications', () => ({
  adminPluginPublicationApis: {
    getPublicationRequest: jest.fn(),
    returnPublicationRequest: jest.fn(),
    acceptPublicationRequest: jest.fn(),
    reconcilePublicationRequest: jest.fn(),
  },
}))

const mockToast = jest.fn()
const mockT = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: mockT }),
}))

jest.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DrawerContent: ({
    children,
    showHandle: _showHandle,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { showHandle?: boolean }) => (
    <div {...props}>{children}</div>
  ),
  DrawerHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DrawerTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  DrawerDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DrawerClose: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}))

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}))

jest.mock('@/features/admin/components/PluginPublicationStatus', () => ({
  PluginPublicationStatusTag: () => <span>status</span>,
  PluginPublicationRiskTag: () => <span>risk</span>,
  PluginPublicationCheckTags: () => <span>check tags</span>,
  PluginPublicationStageProgress: () => <div>stage progress</div>,
}))

const revisionFixture = {
  id: 103,
  number: 3,
  requestedVersion: '1.2.0',
  snapshotSha256: 'a'.repeat(64),
  status: 'awaiting_admin' as const,
  releaseNotes: 'Adds message search',
  testNotes: 'Tested on Windows and macOS',
  createdAt: '2026-08-29T01:00:00Z',
  declarations: [],
  manifest: {
    name: 'sina-email',
    version: '1.2.0',
    interface: { capabilities: ['Read', 'Write'] },
  },
  packageEntries: ['.codex-plugin/plugin.json', 'skills/sina-email/SKILL.md'],
  packageEntryCount: 2,
  packageEntriesTruncated: false,
  capabilities: ['Read', 'Write'],
}

const previousRevisionFixture = {
  ...revisionFixture,
  id: 102,
  number: 2,
  requestedVersion: '1.1.0',
  snapshotSha256: 'b'.repeat(64),
  status: 'changes_requested' as const,
  manifest: {
    name: 'sina-email',
    version: '1.1.0',
    interface: { capabilities: ['Read'] },
  },
  packageEntries: ['.codex-plugin/plugin.json', 'skills/legacy/SKILL.md'],
  capabilities: ['Read'],
}

const detailFixture: AdminPluginPublicationRequestDetail = {
  id: 41,
  pluginId: 7,
  pluginName: 'Company Mail',
  pluginSlug: 'sina-email',
  requestedVersion: '1.2.0',
  submitter: { id: 9, userName: 'alice' },
  currentRevision: 3,
  stage: 'administrator_review',
  status: 'awaiting_admin',
  riskLevel: 'medium',
  blockerCount: 0,
  warningCount: 1,
  submittedAt: '2026-08-29T01:00:00Z',
  updatedAt: '2026-08-29T02:00:00Z',
  revision: revisionFixture,
  revisions: [revisionFixture, previousRevisionFixture],
  checks: [
    {
      id: 501,
      checkCode: 'risk.external_network',
      title: 'External network access',
      severity: 'warning',
      status: 'warning',
      summary: 'The plugin accesses mail.example.com',
      evidence: ['plugin.json:12'],
      acknowledgementRequired: true,
      acknowledged: false,
    },
  ],
  events: [],
  gitlab: null,
  actionEligibility: {
    canReturn: true,
    canAccept: true,
    canReconcile: true,
    blockedReasons: [],
  },
}

const historicalDetailFixture: AdminPluginPublicationRequestDetail = {
  ...detailFixture,
  revision: previousRevisionFixture,
  checks: [
    {
      id: 401,
      checkCode: 'HISTORICAL_WINDOWS_TEST',
      title: 'Historical Windows evidence',
      severity: 'blocker',
      status: 'failed',
      summary: 'The old revision did not pass Windows checks',
      evidence: ['revision-2-windows-job'],
      acknowledgementRequired: false,
      acknowledged: false,
    },
  ],
  events: [
    {
      id: 301,
      eventType: 'returned',
      actorType: 'admin',
      actorName: 'reviewer',
      message: 'Revision 2 returned for Windows fixes',
      createdAt: '2026-08-28T03:00:00Z',
    },
  ],
  gitlab: {
    sourceBranch: 'wework/publication-41-r2',
    mergeRequestStatus: 'closed',
    pipelineStatus: 'failed',
  },
}

const mockedPublicationApis = adminPluginPublicationApis as jest.Mocked<
  typeof adminPluginPublicationApis
>

describe('PluginPublicationReviewDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPublicationApis.getPublicationRequest.mockImplementation(
      async (_requestId, _signal, revision) =>
        revision === 2 ? historicalDetailFixture : detailFixture
    )
    mockedPublicationApis.returnPublicationRequest.mockResolvedValue(detailFixture)
    mockedPublicationApis.acceptPublicationRequest.mockResolvedValue({
      ...detailFixture,
      status: 'admin_accepted',
    })
    mockedPublicationApis.reconcilePublicationRequest.mockResolvedValue(detailFixture)
  })

  it('requires warning acknowledgement and accepts only the current revision', async () => {
    render(
      <PluginPublicationReviewDrawer
        requestId={41}
        onOpenChange={jest.fn()}
        onRequestUpdated={jest.fn()}
      />
    )

    const acceptButton = await screen.findByTestId('plugin-publication-accept')
    expect(acceptButton).toBeDisabled()
    expect(screen.getByTestId('plugin-publication-revision-history')).toHaveTextContent(
      'Revision 3 · v1.2.0'
    )

    fireEvent.click(screen.getByTestId('plugin-publication-warning-ack-risk.external_network'))
    expect(acceptButton).toBeEnabled()
    fireEvent.click(acceptButton)

    expect(screen.getByTestId('plugin-publication-accept-dialog')).toHaveTextContent(
      'marketplace_management.plugin_publications.accept_dialog.not_publish_notice'
    )
    expect(screen.getByTestId('plugin-publication-accept-target')).toHaveTextContent(
      'Company Mail (v1.2.0)'
    )
    expect(screen.getByTestId('plugin-publication-accept-target')).toHaveTextContent(
      '#41 / Revision 3'
    )
    expect(screen.getByTestId('plugin-publication-accept-target')).toHaveTextContent('a'.repeat(64))
    expect(screen.getByTestId('plugin-publication-accept-target-repository')).toHaveTextContent(
      'weibo_rd/common/wecode/wework-plugins'
    )
    expect(screen.getByTestId('plugin-publication-accept-target-directory')).toHaveTextContent(
      'plugins/sina-email'
    )
    fireEvent.click(screen.getByTestId('plugin-publication-accept-confirm'))

    await waitFor(() =>
      expect(mockedPublicationApis.acceptPublicationRequest).toHaveBeenCalledWith(41, {
        currentRevision: 3,
        acknowledgedWarningCodes: ['risk.external_network'],
      })
    )
  })

  it('requires actionable return fields and submits one change per line', async () => {
    render(
      <PluginPublicationReviewDrawer
        requestId={41}
        onOpenChange={jest.fn()}
        onRequestUpdated={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByTestId('plugin-publication-return'))
    const confirmButton = screen.getByTestId('plugin-publication-return-confirm')
    expect(confirmButton).toBeDisabled()

    fireEvent.change(screen.getByTestId('plugin-publication-return-reason'), {
      target: { value: 'Risk declaration is incomplete' },
    })
    fireEvent.change(screen.getByTestId('plugin-publication-required-changes'), {
      target: {
        value:
          'Declare the external domain\nAdd a Windows test result\nDeclare the external domain',
      },
    })
    expect(confirmButton).toBeEnabled()
    fireEvent.click(confirmButton)

    await waitFor(() =>
      expect(mockedPublicationApis.returnPublicationRequest).toHaveBeenCalledWith(41, {
        currentRevision: 3,
        reason: 'Risk declaration is incomplete',
        requiredChanges: ['Declare the external domain', 'Add a Windows test result'],
      })
    )
  })

  it('prefills failed checks as structured return requirements', async () => {
    const blockedDetail: AdminPluginPublicationRequestDetail = {
      ...detailFixture,
      blockerCount: 1,
      checks: [
        {
          id: 502,
          checkCode: 'compatibility.windows_native',
          title: 'Windows native compatibility',
          severity: 'blocker',
          status: 'failed',
          summary: 'Windows job failed',
          evidence: ['job-502'],
          acknowledgementRequired: false,
          acknowledged: false,
        },
      ],
      actionEligibility: {
        ...detailFixture.actionEligibility,
        canAccept: false,
        blockedReasons: ['compatibility.windows_native'],
      },
    }
    mockedPublicationApis.getPublicationRequest.mockResolvedValueOnce(blockedDetail)
    mockedPublicationApis.returnPublicationRequest.mockResolvedValueOnce(blockedDetail)

    render(
      <PluginPublicationReviewDrawer
        requestId={41}
        onOpenChange={jest.fn()}
        onRequestUpdated={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByTestId('plugin-publication-return'))
    expect(
      screen.getByTestId('plugin-publication-return-check-compatibility.windows_native')
    ).toBeChecked()
    fireEvent.change(screen.getByTestId('plugin-publication-return-reason'), {
      target: { value: 'Native compatibility failed' },
    })
    fireEvent.click(screen.getByTestId('plugin-publication-return-confirm'))

    await waitFor(() =>
      expect(mockedPublicationApis.returnPublicationRequest).toHaveBeenCalledWith(41, {
        currentRevision: 3,
        reason: 'Native compatibility failed',
        requiredChanges: [
          'marketplace_management.plugin_publications.checks.codes.compatibility_windows_native (compatibility.windows_native)',
        ],
      })
    )
  })

  it('reconciles GitLab state for the current revision', async () => {
    render(
      <PluginPublicationReviewDrawer
        requestId={41}
        onOpenChange={jest.fn()}
        onRequestUpdated={jest.fn()}
      />
    )

    fireEvent.click(await screen.findByTestId('plugin-publication-reconcile'))

    await waitFor(() =>
      expect(mockedPublicationApis.reconcilePublicationRequest).toHaveBeenCalledWith(
        41,
        {
          currentRevision: 3,
        },
        expect.any(String)
      )
    )
  })

  it('switches revision and reloads that revision checks, events, and GitLab evidence', async () => {
    render(
      <PluginPublicationReviewDrawer
        requestId={41}
        onOpenChange={jest.fn()}
        onRequestUpdated={jest.fn()}
      />
    )

    expect(await screen.findByTestId('plugin-publication-manifest')).toHaveTextContent('1.2.0')
    expect(screen.getByTestId('plugin-publication-package-entries')).toHaveTextContent(
      'skills/sina-email/SKILL.md'
    )
    expect(screen.getByTestId('plugin-publication-capabilities')).toHaveTextContent('Write')
    expect(screen.getByText('2026-08-29 09:00:00')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('plugin-publication-revision-2'))

    await waitFor(() =>
      expect(mockedPublicationApis.getPublicationRequest).toHaveBeenCalledWith(41, undefined, 2)
    )
    expect(await screen.findByTestId('plugin-publication-historical-revision-notice')).toBeVisible()
    expect(screen.getByTestId('plugin-publication-manifest')).toHaveTextContent('1.1.0')
    expect(screen.getByTestId('plugin-publication-package-entries')).toHaveTextContent(
      'skills/legacy/SKILL.md'
    )
    expect(
      screen.getByTestId('plugin-publication-check-HISTORICAL_WINDOWS_TEST')
    ).toHaveTextContent('revision-2-windows-job')
    expect(screen.getByText('Revision 2 returned for Windows fixes')).toBeInTheDocument()
    expect(screen.getByText(/2026-08-28 11:00:00/)).toBeInTheDocument()
    expect(screen.queryByText(/2026-08-28T03:00:00Z/)).not.toBeInTheDocument()
    expect(screen.getByText('wework/publication-41-r2')).toBeInTheDocument()
    expect(screen.queryByTestId('plugin-publication-accept')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('plugin-publication-return-current-revision'))
    await waitFor(() =>
      expect(mockedPublicationApis.getPublicationRequest).toHaveBeenCalledWith(41, undefined, 3)
    )
  })

  it('shows safe Pipeline failure details and allows an administrator to return it', async () => {
    mockedPublicationApis.getPublicationRequest.mockResolvedValueOnce({
      ...detailFixture,
      status: 'code_changes_requested',
      stage: 'code_review',
      events: [
        {
          id: 901,
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
          createdAt: '2026-08-29T03:00:00Z',
        },
      ],
      actionEligibility: {
        canReturn: true,
        canAccept: false,
        canReconcile: true,
        blockedReasons: [],
      },
    })

    render(
      <PluginPublicationReviewDrawer
        requestId={41}
        onOpenChange={jest.fn()}
        onRequestUpdated={jest.fn()}
      />
    )

    expect(await screen.findByTestId('plugin-publication-event-failures-901')).toHaveTextContent(
      'wework-linux · verify'
    )
    expect(screen.getByRole('link', { name: /open_failed_job/ })).toHaveAttribute(
      'href',
      'https://git.example.com/jobs/301'
    )
    expect(screen.getByTestId('plugin-publication-return')).toBeVisible()
  })
})
