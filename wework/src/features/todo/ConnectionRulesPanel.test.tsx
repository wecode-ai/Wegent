import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../../../../packages/collaboration/src/i18n'
import { ConnectionRulesPanel, type ConnectionRulesApi } from '@wegent/collaboration/automation'

const source = {
  providerId: 'test/mail',
  id: 'inbox',
  profile: 'private-account',
  kind: 'inbox',
  name: 'Private mailbox',
}
const project = { id: 'project', store: 'local' as const }
const targets = [{ id: 'agent', kind: 'agent' as const, name: 'Processor' }]
const translate = (_key: string, fallback?: string) => fallback ?? _key

function fixture() {
  return {
    list: vi.fn().mockResolvedValue([]),
    save: vi.fn().mockImplementation(async rule => ({ ...rule, version: 1 })),
    remove: vi.fn().mockResolvedValue(undefined),
    runs: vi.fn().mockResolvedValue([]),
    retry: vi.fn().mockResolvedValue(undefined),
    providers: vi.fn().mockResolvedValue([
      {
        id: 'test/mail',
        displayName: 'Mail',
        resourceKinds: ['inbox'],
        eventTypes: ['mail.received'],
        availability: { status: 'ready' },
      },
    ]),
    resources: vi.fn().mockResolvedValue([source]),
  } satisfies ConnectionRulesApi
}

describe('Connection rules', () => {
  it('discovers sources only when creating a rule and saves an explicit publication boundary', async () => {
    const api = fixture()
    render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    await waitFor(() => expect(screen.getByTestId('connection-rule-create')).toBeEnabled())
    expect(api.providers).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('connection-rule-create'))
    expect(await screen.findByTestId('connection-rule-editor')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('connection-rule-name'), {
      target: { value: 'Customer failures' },
    })
    fireEvent.click(screen.getByTestId('connection-rule-search'))
    await screen.findByText('Private mailbox')
    fireEvent.change(screen.getByTestId('connection-rule-resource'), {
      target: { value: JSON.stringify(source) },
    })
    api.resources.mockResolvedValue([{ ...source, id: 'other-inbox', name: 'Other mailbox' }])
    fireEvent.change(screen.getByTestId('connection-rule-query'), { target: { value: 'other' } })
    fireEvent.click(screen.getByTestId('connection-rule-search'))
    await screen.findByText('Other mailbox')
    expect(screen.getByRole('option', { name: 'Private mailbox' })).toHaveProperty('selected', true)
    fireEvent.change(screen.getByTestId('connection-rule-processing-contains'), {
      target: { value: 'failure' },
    })
    fireEvent.change(screen.getByTestId('connection-rule-title'), {
      target: { value: 'Reported failure' },
    })
    fireEvent.change(screen.getByTestId('connection-rule-publication'), {
      target: { value: 'Publish an anonymized summary' },
    })
    fireEvent.submit(screen.getByTestId('connection-rule-editor'))
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith(
        expect.objectContaining({
          source,
          eventType: 'mail.received',
          project,
          condition: { contains: 'failure' },
          publication: { title: 'Reported failure', instruction: 'Publish an anonymized summary' },
          targetKind: 'agent',
          targetId: 'agent',
        })
      )
    )
    await waitFor(() =>
      expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
    )
  })

  it('isolates private lists when switching projects and ignores a late source request', async () => {
    const api = fixture()
    let resolve!: (items: Awaited<ReturnType<ConnectionRulesApi['providers']>>) => void
    api.providers.mockReturnValue(
      new Promise(done => {
        resolve = done
      })
    )
    const view = render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    await waitFor(() => expect(screen.getByTestId('connection-rule-create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('connection-rule-create'))
    view.rerender(
      <ConnectionRulesPanel
        api={api}
        project={{ id: 'other', store: 'cloud' }}
        targets={targets}
        translate={translate}
      />
    )
    await act(async () =>
      resolve([
        {
          id: 'private',
          displayName: 'Private mailbox',
          resourceKinds: ['inbox'],
          eventTypes: ['mail.received'],
          availability: { status: 'ready' },
        },
      ])
    )
    expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
    expect(screen.queryByText('Private mailbox')).not.toBeInTheDocument()
    expect(api.list).toHaveBeenLastCalledWith({ id: 'other', store: 'cloud' })
  })

  it('opens published Issues from history without entering the editor and translates runtime statuses', async () => {
    const api = fixture()
    api.list.mockResolvedValue([
      {
        id: 'saved',
        version: 1,
        name: 'Failures',
        enabled: true,
        source,
        project,
        eventType: 'mail.received',
        condition: { contains: 'failure' },
        targetKind: 'agent',
        targetId: 'agent',
        publication: { title: 'Summary', instruction: 'Anonymize' },
        lastRunStatus: 'published',
      },
    ])
    api.runs.mockResolvedValue([
      {
        id: 'run',
        ruleId: 'saved',
        status: 'published',
        createdAt: new Date().toISOString(),
        issueId: 'issue',
      },
    ])
    const onOpenIssue = vi.fn()
    const t = createCollaborationTranslator('zh-CN')
    render(
      <ConnectionRulesPanel
        api={api}
        project={project}
        targets={targets}
        translate={t}
        onOpenIssue={onOpenIssue}
      />
    )
    fireEvent.click(await screen.findByTestId('connection-rule-history-saved'))
    expect(await screen.findByTestId('connection-rule-runs')).toHaveTextContent('已创建 Issue')
    expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
    expect(api.providers).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('connection-rule-issue-run'))
    await waitFor(() => expect(onOpenIssue).toHaveBeenCalledWith('issue'))
    expect(t('automation_rules.values.ready')).toBe('可用')
    expect(t('automation_rules.values.record_received')).toBe('收到新记录')
    expect(createCollaborationTranslator('en')('automation_rules.values.published')).toBe(
      'Issue created'
    )
  })

  it('offers a local retry after loading fails', async () => {
    const api = fixture()
    api.list.mockRejectedValueOnce(new Error('Executor offline'))
    render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Executor offline')
    fireEvent.click(screen.getByTestId('connection-rule-reload'))
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
  it('keeps cached cloud rules visible with a scoped sync error and clears it on recovery', async () => {
    vi.useFakeTimers()
    const api = fixture()
    const cloudProject = { id: 'cloud', store: 'cloud' as const }
    const rule = {
      id: 'cloud-rule',
      version: 1,
      name: 'Cloud snapshot',
      enabled: true,
      source,
      project: cloudProject,
      eventType: 'mail.received',
      targetKind: 'agent',
      targetId: 'agent',
      publication: { title: 'Summary', instruction: 'Anonymize' },
      cloudSyncError: 'cloud_unavailable',
    }
    api.list.mockResolvedValue([rule])
    const view = render(
      <ConnectionRulesPanel
        api={api}
        project={cloudProject}
        targets={targets}
        translate={translate}
      />
    )
    try {
      await act(async () => {})
      expect(screen.getByTestId('connection-rule-edit-cloud-rule')).toBeEnabled()
      expect(screen.getByTestId('connection-rule-cloud-sync-cloud-rule')).toHaveTextContent(
        '云项目暂时无法同步'
      )
      api.list.mockResolvedValue([
        { ...rule, cloudSyncError: undefined, name: 'Current project rule' },
      ])
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.queryByTestId('connection-rule-cloud-sync-cloud-rule')).not.toBeInTheDocument()
      expect(screen.getByText('Current project rule')).toBeInTheDocument()
    } finally {
      view.unmount()
      vi.useRealTimers()
    }
  })
})
