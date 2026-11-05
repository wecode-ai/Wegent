import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../../../../packages/collaboration/src/i18n'
import {
  ConnectionRulesPanel,
  PrivateConnectionRulesButton,
  type ConnectionRulesApi,
} from '@wegent/collaboration/automation'
import { ProjectAutomaticProcessing } from '../../../../packages/collaboration/src/project-manage/ProjectAutomaticProcessing'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'

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
    ownerScope: 'account-A/current-native',
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

function sharedFixture() {
  return {
    projects: {},
    agents: { list: vi.fn().mockResolvedValue([]) },
    members: {
      list: vi.fn().mockResolvedValue([{ id: 'agent', user_id: 7, user_name: 'Processor' }]),
    },
    automations: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as SharedWorkspaceApi
}
function projectView(
  api: ConnectionRulesApi,
  sharedApi = sharedFixture(),
  target: typeof project | { id: string; store: 'cloud' } = project
) {
  return (
    <ProjectAutomaticProcessing
      api={sharedApi}
      project={{ ...target, access_role: 'Owner', statuses: [] } as unknown as CollaborationProject}
      members={[]}
      agents={[]}
      locale="zh-CN"
      translate={translate}
      connectionRules={api}
      connectionProject={target}
    />
  )
}

describe('Connection rules', () => {
  const privateRule = {
    id: 'private-rule',
    version: 1,
    name: 'PRIVATE_ACCOUNT_A_RULE',
    enabled: true,
    source,
    project,
    eventType: 'mail.received',
    targetKind: 'agent' as const,
    targetId: 'agent',
    publication: { title: 'Summary', instruction: 'PRIVATE_ACCOUNT_A_INSTRUCTION' },
  }

  it('opens private history and removal independently of project settings', async () => {
    const api = fixture()
    api.list.mockResolvedValue([privateRule])
    api.remove.mockImplementation(async () => {
      api.list.mockResolvedValue([])
    })
    render(<PrivateConnectionRulesButton api={api} project={project} translate={translate} />)
    expect(api.list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('private-connection-rules-open'))
    expect(await screen.findByTestId('connection-rule-edit-private-rule')).toBeDisabled()
    fireEvent.click(screen.getByTestId('connection-rule-history-private-rule'))
    await waitFor(() => expect(api.runs).toHaveBeenCalledWith('private-rule'))
    fireEvent.click(screen.getByTestId('connection-rule-remove-private-rule'))
    await waitFor(() => expect(screen.queryByText(privateRule.name)).not.toBeInTheDocument())
    expect(api.remove).toHaveBeenCalledWith('private-rule', 1)
    expect(api.save).not.toHaveBeenCalled()
    expect(screen.queryByTestId('connection-rule-runs')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('private-connection-rules-close'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes the private management dialog when its account changes', async () => {
    const api = fixture()
    api.list.mockResolvedValue([privateRule])
    const view = render(
      <PrivateConnectionRulesButton api={api} project={project} translate={translate} />
    )
    fireEvent.click(screen.getByTestId('private-connection-rules-open'))
    await screen.findByText(privateRule.name)
    view.rerender(
      <PrivateConnectionRulesButton
        api={{ ...api, ownerScope: 'account-B' }}
        project={project}
        translate={translate}
      />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(privateRule.name)).not.toBeInTheDocument()
  })

  it('lets a project Viewer read history and remove only their private rule', async () => {
    const api = fixture()
    api.list.mockResolvedValue([privateRule])
    api.remove.mockImplementation(async () => {
      api.list.mockResolvedValue([])
    })
    const sharedApi = {
      projects: {},
      agents: { list: vi.fn().mockResolvedValue([]) },
      members: { list: vi.fn().mockResolvedValue([]) },
      automations: { list: vi.fn().mockResolvedValue([]) },
    } as unknown as SharedWorkspaceApi
    render(
      <ProjectAutomaticProcessing
        api={sharedApi}
        project={
          { ...project, access_role: 'Viewer', statuses: [] } as unknown as CollaborationProject
        }
        members={[]}
        agents={[]}
        locale="zh-CN"
        translate={translate}
        connectionRules={api}
        connectionProject={project}
      />
    )
    expect(await screen.findByTestId('connection-rule-remove-private-rule')).toBeEnabled()
    expect(screen.getByTestId('connection-rule-history-private-rule')).toBeEnabled()
    expect(screen.queryByTestId('connection-rule-create')).not.toBeInTheDocument()
    expect(screen.getByTestId('connection-rule-edit-private-rule')).toBeDisabled()
    expect(screen.queryByTestId('connection-rule-toggle-private-rule')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('connection-rule-remove-private-rule'))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('private-rule', 1))
    await waitFor(() => expect(screen.queryByText(privateRule.name)).not.toBeInTheDocument())
    expect(api.save).not.toHaveBeenCalled()
  })

  it('blocks an already-open editor after project management permission is lost', async () => {
    const api = fixture()
    api.list.mockResolvedValue([privateRule])
    const view = render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    fireEvent.click(await screen.findByTestId('connection-rule-edit-private-rule'))
    await screen.findByTestId('connection-rule-editor')
    view.rerender(
      <ConnectionRulesPanel
        api={api}
        project={project}
        targets={targets}
        translate={translate}
        canConfigureProject={false}
      />
    )
    expect(screen.getByTestId('connection-rule-save')).toBeDisabled()
    expect(screen.getByTestId('connection-rule-publication')).toBeDisabled()
    fireEvent.submit(screen.getByTestId('connection-rule-editor'))
    expect(api.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('connection-rule-cancel'))
    expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
  })

  it('clears private rules, draft and history synchronously when the owner changes', async () => {
    const api = fixture()
    api.list.mockResolvedValue([privateRule])
    const view = render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    fireEvent.click(await screen.findByTestId('connection-rule-history-private-rule'))
    await screen.findByTestId('connection-rule-runs')
    fireEvent.click(screen.getByTestId('connection-rule-edit-private-rule'))
    expect(await screen.findByTestId('connection-rule-publication')).toHaveValue(
      privateRule.publication.instruction
    )
    const next = { ...fixture(), ownerScope: 'account-B/current-native' }
    let reject!: (reason: Error) => void
    next.list.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail
      })
    )
    view.rerender(
      <ConnectionRulesPanel api={next} project={project} targets={targets} translate={translate} />
    )
    expect(screen.queryByText(privateRule.name)).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-rule-runs')).not.toBeInTheDocument()
    await act(async () => reject(new Error('Account B offline')))
    expect(screen.getByTestId('connection-rule-error')).toHaveTextContent('Account B offline')
    expect(screen.queryByText(privateRule.name)).not.toBeInTheDocument()
  })

  it('keeps an unsaved draft when the API is refreshed for the same owner', async () => {
    const api = fixture()
    api.list.mockResolvedValue([privateRule])
    const view = render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    fireEvent.click(await screen.findByTestId('connection-rule-edit-private-rule'))
    await screen.findByTestId('connection-rule-publication')
    const next = fixture()
    next.list.mockResolvedValue([privateRule])
    view.rerender(
      <ConnectionRulesPanel api={next} project={project} targets={targets} translate={translate} />
    )
    expect(screen.getByTestId('connection-rule-publication')).toHaveValue(
      privateRule.publication.instruction
    )
  })

  it('uses one project entry and the personal connection picker before configuring a publication', async () => {
    const api = fixture()
    render(projectView(api))
    await waitFor(() => expect(screen.getByTestId('automatic-processing-create')).toBeEnabled())
    expect(api.providers).not.toHaveBeenCalled()
    expect(screen.queryByTestId('connection-rule-create')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.click(await screen.findByTestId('project-rule-connection-test/mail'))
    expect(await screen.findByTestId('connection-rule-resource-picker')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-rule-name')).not.toBeInTheDocument()
    expect(screen.queryByTestId('connection-rule-provider')).not.toBeInTheDocument()
    expect(screen.getByTestId('connection-rule-next')).toBeDisabled()
    fireEvent.click(screen.getByTestId('connection-rule-search'))
    fireEvent.click(await screen.findByTestId('connection-rule-result-inbox'))
    api.resources.mockResolvedValue([{ ...source, id: 'other-inbox', name: 'Other mailbox' }])
    fireEvent.change(screen.getByTestId('connection-rule-query'), { target: { value: 'other' } })
    fireEvent.click(screen.getByTestId('connection-rule-search'))
    await screen.findByText('Other mailbox')
    expect(screen.getByTestId('connection-rule-result-inbox')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.click(screen.getByTestId('connection-rule-next'))
    expect(screen.getByTestId('connection-rule-selected-source')).toHaveTextContent(source.name)
    fireEvent.change(screen.getByTestId('connection-rule-name'), {
      target: { value: 'Customer failures' },
    })
    fireEvent.click(screen.getByTestId('connection-rule-processing-conditions'))
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
          targetKind: 'human',
          targetId: '7',
        })
      )
    )
    await waitFor(() =>
      expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
    )
  })

  it.each([
    ['projects', 'created'],
    ['time', 'schedule'],
  ] as const)(
    'configures the %s connection and returns to connection choices',
    async (connection, trigger) => {
      const api = fixture()
      render(projectView(api))
      fireEvent.click(await screen.findByTestId('automatic-processing-create'))
      fireEvent.click(await screen.findByTestId('project-rule-connection-' + connection))
      expect(await screen.findByTestId('automatic-processing-trigger-' + trigger)).toBeChecked()
      expect(
        screen.queryByTestId(
          'automatic-processing-trigger-' + (connection === 'time' ? 'created' : 'schedule')
        )
      ).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('automatic-processing-back'))
      expect(await screen.findByTestId('project-rule-connection-picker')).toBeInTheDocument()
      fireEvent.click(screen.getByTestId('project-rule-connection-close'))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(api.save).not.toHaveBeenCalled()
    }
  )

  it('keeps project and time connections usable while source discovery fails and recovers on retry', async () => {
    const api = fixture()
    api.providers.mockRejectedValueOnce(new Error('Device disconnected'))
    render(projectView(api))
    fireEvent.click(await screen.findByTestId('automatic-processing-create'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Device disconnected')
    expect(screen.getByTestId('project-rule-connection-projects')).toBeEnabled()
    expect(screen.getByTestId('project-rule-connection-time')).toBeEnabled()
    fireEvent.click(screen.getByTestId('project-rule-connection-retry'))
    fireEvent.click(await screen.findByTestId('project-rule-connection-test/mail'))
    fireEvent.click(await screen.findByTestId('connection-rule-back'))
    expect(await screen.findByTestId('project-rule-connection-picker')).toBeInTheDocument()
    expect(screen.queryByTestId('connection-rule-editor')).not.toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('preserves an unsaved source draft when returning to the connection list, and discards it when starting a new rule', async () => {
    const api = fixture()
    render(projectView(api))
    fireEvent.click(await screen.findByTestId('automatic-processing-create'))
    fireEvent.click(await screen.findByTestId('project-rule-connection-test/mail'))
    fireEvent.click(await screen.findByTestId('connection-rule-search'))
    fireEvent.click(await screen.findByTestId('connection-rule-result-inbox'))
    fireEvent.click(screen.getByTestId('connection-rule-next'))
    fireEvent.change(screen.getByTestId('connection-rule-name'), {
      target: { value: 'Keep this draft' },
    })
    fireEvent.change(screen.getByTestId('connection-rule-publication'), {
      target: { value: 'PRIVATE UNSAVED REQUIREMENT' },
    })
    fireEvent.click(screen.getByTestId('connection-rule-back'))
    fireEvent.click(screen.getByTestId('connection-rule-back'))
    fireEvent.click(await screen.findByTestId('project-rule-connection-test/mail'))
    expect(screen.getByTestId('connection-rule-result-inbox')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.click(screen.getByTestId('connection-rule-next'))
    expect(screen.getByTestId('connection-rule-name')).toHaveValue('Keep this draft')
    expect(screen.getByTestId('connection-rule-publication')).toHaveValue(
      'PRIVATE UNSAVED REQUIREMENT'
    )
    fireEvent.click(screen.getByTestId('connection-rule-cancel'))
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    fireEvent.click(await screen.findByTestId('project-rule-connection-test/mail'))
    expect(screen.getByTestId('connection-rule-next')).toBeDisabled()
    expect(screen.queryByDisplayValue('PRIVATE UNSAVED REQUIREMENT')).not.toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it('keeps optional conditions expanded while clearing the final filter', async () => {
    const api = fixture()
    api.list.mockResolvedValue([{ ...privateRule, condition: { contains: 'Clear this filter' } }])
    render(
      <ConnectionRulesPanel api={api} project={project} targets={targets} translate={translate} />
    )
    fireEvent.click(await screen.findByTestId('connection-rule-edit-private-rule'))
    const input = await screen.findByTestId('connection-rule-processing-contains')
    expect(input.closest('details')).toHaveAttribute('open')
    fireEvent.change(input, { target: { value: '' } })
    expect(input.closest('details')).toHaveAttribute('open')
  })

  it('isolates private lists when switching projects and ignores a late source request', async () => {
    const api = fixture()
    let resolve!: (items: Awaited<ReturnType<ConnectionRulesApi['providers']>>) => void
    api.providers.mockReturnValue(
      new Promise(done => {
        resolve = done
      })
    )
    const sharedApi = sharedFixture()
    const view = render(projectView(api, sharedApi))
    await waitFor(() => expect(screen.getByTestId('automatic-processing-create')).toBeEnabled())
    fireEvent.click(screen.getByTestId('automatic-processing-create'))
    view.rerender(projectView(api, sharedApi, { id: 'other', store: 'cloud' }))
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
