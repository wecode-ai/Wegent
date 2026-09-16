// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'

import { codeWikiApi } from '@/apis/code-wiki'
import { userApis } from '@/apis/user'
import { ScheduledUpdateDialog } from '@/features/knowledge/code-wiki/ScheduledUpdateDialog'
import type { CodeWikiScheduledUpdate } from '@/types/code-wiki'

const translations: Record<string, string> = {
  'codeWiki.scheduledUpdate.advanced': 'Advanced settings',
  'codeWiki.scheduledUpdate.history': 'Recent checks',
  'codeWiki.scheduledUpdate.results.repositoryUnchanged': 'Repository unchanged',
  'feed:status_failed': 'Failed',
  'feed:status_completed_silent': 'Completed (silent)',
}

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      if (key === 'codeWiki.scheduledUpdate.next') return `Next check: ${values?.when}`
      if (key === 'codeWiki.scheduledUpdate.timezoneHint') return `Time zone: ${values?.timezone}`
      return translations[key] ?? key
    },
    i18n: { language: 'en-US' },
  }),
}))

jest.mock('@/apis/code-wiki', () => ({
  codeWikiApi: { scheduledUpdate: jest.fn() },
}))

jest.mock('@/apis/user', () => ({
  userApis: { getUsersByIds: jest.fn() },
}))

jest.mock('@/components/common/UserSearchSelect', () => ({
  UserSearchSelect: () => <div data-testid="runner-select" />,
}))

const PLAN: CodeWikiScheduledUpdate = {
  can_configure: true,
  configured: true,
  cadence: 'daily',
  enabled: true,
  interval_days: 1,
  weekday: 0,
  hour: 19,
  minute: 0,
  timezone: 'Asia/Shanghai',
  execution_principal_user_id: null,
  next_execution_time: '2026-09-15T11:00:00',
  executions: [
    {
      id: 3,
      status: 'FAILED',
      error_message: 'repository unavailable',
      result_summary: '',
      task_id: 0,
      created_at: '2026-09-15T10:30:00',
    },
    {
      id: 2,
      status: 'COMPLETED_SILENT',
      error_message: '',
      result_summary: 'repository unchanged since last run',
      task_id: 0,
      created_at: '2026-09-14T10:30:00',
    },
  ],
}

async function renderDialog() {
  jest.mocked(codeWikiApi.scheduledUpdate).mockResolvedValue(PLAN)
  render(
    <ScheduledUpdateDialog
      knowledgeBaseId={7}
      open
      onOpenChange={jest.fn()}
      onDraftSaved={jest.fn()}
      onDeleteRequested={jest.fn()}
    />
  )
  return screen.findByTestId('code-wiki-scheduled-advanced')
}

describe('Code Wiki scheduled update details', () => {
  beforeEach(() => jest.clearAllMocks())

  it('preserves explicitly clearing a runner when reopening an unapplied draft', async () => {
    jest.mocked(codeWikiApi.scheduledUpdate).mockResolvedValue({
      ...PLAN,
      execution_principal_user_id: 23,
    })
    const onDraftSaved = jest.fn()
    render(
      <ScheduledUpdateDialog
        knowledgeBaseId={7}
        open
        draft={{ ...PLAN, execution_principal_user_id: null }}
        onOpenChange={jest.fn()}
        onDraftSaved={onDraftSaved}
        onDeleteRequested={jest.fn()}
      />
    )

    const save = await screen.findByTestId('code-wiki-scheduled-time')
    expect(save).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('code-wiki-scheduled-save'))
    expect(onDraftSaved).toHaveBeenCalledWith(
      expect.objectContaining({ execution_principal_user_id: null })
    )
    expect(userApis.getUsersByIds).not.toHaveBeenCalled()
  })

  it('keeps non-owner schedule settings read-only without staging mutations', async () => {
    jest.mocked(codeWikiApi.scheduledUpdate).mockResolvedValue({ ...PLAN, can_configure: false })
    const onDraftSaved = jest.fn()
    const onDeleteRequested = jest.fn()
    render(
      <ScheduledUpdateDialog
        knowledgeBaseId={7}
        open
        onOpenChange={jest.fn()}
        onDraftSaved={onDraftSaved}
        onDeleteRequested={onDeleteRequested}
      />
    )

    await screen.findByTestId('code-wiki-scheduled-read-only')
    expect(screen.getByTestId('code-wiki-scheduled-enabled')).toBeDisabled()
    expect(screen.getByTestId('code-wiki-scheduled-time')).toBeDisabled()
    const save = screen.getByTestId('code-wiki-scheduled-save')
    expect(save).toBeDisabled()
    fireEvent.click(save)
    expect(onDraftSaved).not.toHaveBeenCalled()
    expect(onDeleteRequested).not.toHaveBeenCalled()
    expect(screen.queryByTestId('code-wiki-scheduled-delete')).not.toBeInTheDocument()
  })

  it('places the borderless advanced section after ordinary schedule information', async () => {
    const advanced = await renderDialog()
    const history = screen.getByText('Recent checks')

    expect(
      history.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(advanced.parentElement).not.toHaveClass('border')
  })

  it('formats the next check and history in the configured IANA timezone', async () => {
    await renderDialog()
    const formatter = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'Asia/Shanghai',
    })

    expect(
      screen.getByText(`Next check: ${formatter.format(new Date('2026-09-15T11:00:00Z'))}`)
    ).toBeInTheDocument()
    expect(screen.getByText(formatter.format(new Date('2026-09-15T10:30:00Z')))).toBeInTheDocument()
  })

  it('uses the existing localized subscription status label', async () => {
    await renderDialog()

    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('FAILED')).not.toBeInTheDocument()
    expect(screen.getByText('Completed (silent)')).toBeInTheDocument()
    expect(screen.getByText('Repository unchanged')).toBeInTheDocument()
    expect(screen.queryByText('repository unchanged since last run')).not.toBeInTheDocument()
    expect(screen.getAllByText('repository unavailable')).not.toHaveLength(0)
  })
})
