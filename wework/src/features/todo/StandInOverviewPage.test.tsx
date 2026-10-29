import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import {
  newStandInRole,
  publishPersonalStandIn,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { StandInInboxWork } from '@/api/standIn'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import '@/i18n'
import { StandInOverviewPage } from './StandInOverviewPage'
vi.mock('./StandInWorkConfirmation', () => ({ StandInWorkConfirmation: () => null }))

vi.mock('./StandInConversation', () => ({
  StandInConversation: ({ roleId }: { roleId?: string }) => (
    <div data-testid="identity-conversation">{roleId ?? 'primary'}</div>
  ),
}))

function fixture(roles: StandInRole[] = [newStandInRole('device', 'default')]) {
  let settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'device',
    version: 0,
    roles,
  }
  const personalAgents = vi.fn(async () => [])
  const personalSave = vi.fn(async (_user, value: PersonalStandInSettings) => {
    settings = value
    return settings
  })
  const props = {
    userId: 7,
    api: {} as SharedWorkspaceApi,
    devices: [],
    projects: [
      { id: '12', name: 'Example project', project_store: 'backend' },
    ] as CollaborationProject[],
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'device' }),
      modelApi: { listModels: async () => ({ data: [] }) },
      standInApi: {
        connectionProviders: vi.fn(async () => ({ items: [] })),
        catalog: async () => ({ models: [] }),
        personalGet: vi.fn(async () => settings),
        memories: vi.fn(async () => []),
        inbox: vi.fn(async () => ({ items: [], sourceErrors: [] })),
        proposal: vi.fn(async () => null),
        personalSave,
        personalAgents,
      },
    } as unknown as WorkbenchServices,
  }
  return { props, personalAgents, personalSave }
}

it('lists existing stand-ins without execution history and keeps project names separate', async () => {
  const role = newStandInRole('device', 'default')
  role.collaboration = {
    ...role.collaboration,
    enabled: true,
    allProjects: false,
    projects: [{ id: '12', store: 'cloud' }],
  }
  const { props } = fixture([role])
  props.projects[0].name = 'Downloads'
  render(<StandInOverviewPage {...props} />)
  const row = await screen.findByTestId('stand-in-overview-role-default')
  expect(within(row).getByText('默认分身')).toBeInTheDocument()
  expect(within(row).getByText('Downloads')).toBeInTheDocument()
  expect(row).toHaveTextContent('已连接 1 个项目')
  expect(row).toHaveTextContent('未开启')
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('primary')
})

it('opens settings for the selected stand-in and reflects its renamed identity', async () => {
  const first = { ...newStandInRole('device', 'first'), name: 'Coding' }
  const second = { ...newStandInRole('device', 'second'), name: 'Reviewer' }
  const { props } = fixture([first, second])
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await user.click(await screen.findByTestId('stand-in-overview-role-second'))
  expect(await screen.findByTestId('stand-in-activity')).toHaveTextContent('尚无处理记录')
  expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-role-chat'))
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('second')
  expect(screen.getByTestId('stand-in-settings-open')).toHaveTextContent('设置')
  await user.click(screen.getByTestId('stand-in-settings-open'))
  expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
  const name = await screen.findByRole('textbox', { name: '分身名称' })
  expect(name).toHaveValue('Reviewer')
  expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
  await user.clear(name)
  await user.type(name, '代码审查')
  await user.click(screen.getByTestId('stand-in-save'))
  await waitFor(() =>
    expect(screen.getByTestId('stand-in-overview-role-second')).toHaveTextContent('代码审查')
  )
  expect(screen.getByTestId('stand-in-overview-role-first')).toHaveTextContent('Coding')
  expect(screen.getByTestId('identity-conversation')).toHaveTextContent('second')
  await user.click(screen.getByTestId('stand-in-settings-open'))
  expect(await screen.findByRole('textbox', { name: '分身名称' })).toHaveValue('代码审查')
  await user.click(screen.getByTestId('stand-in-close'))
  await user.click(screen.getByTestId('stand-in-memory-open'))
  await user.click(await screen.findByTestId('stand-in-memory-add'))
  expect(screen.getByRole('option', { name: '代码审查（与你聊天时）' })).toHaveValue(
    JSON.stringify({ kind: 'role', roleId: 'second' })
  )
})

it('keeps the active conversation mounted while settings reload', async () => {
  const { props } = fixture()
  const api = props.services.standInApi!
  const settings = await api.personalGet(7, 'device')
  let resolveInitial!: (value: typeof settings) => void
  const initial = new Promise<typeof settings>(done => {
    resolveInitial = done
  })
  let resolve!: (value: typeof settings) => void
  const pending = new Promise<typeof settings>(done => {
    resolve = done
  })
  vi.mocked(api.personalGet).mockReturnValueOnce(initial)
  render(<StandInOverviewPage {...props} />)
  try {
    await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(2))
    // Settle initialization and its device-scoped subscription before reloading.
    await act(async () => resolveInitial(settings))
    const conversation = await screen.findByTestId('identity-conversation')
    vi.mocked(api.personalGet).mockReturnValueOnce(pending)
    act(() => publishPersonalStandIn(settings))
    await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('identity-conversation')).toBe(conversation)
    await act(async () => resolve(settings))
    expect(screen.getByTestId('identity-conversation')).toBe(conversation)
  } finally {
    await act(async () => {
      resolveInitial(settings)
      resolve(settings)
    })
  }
})

it('hides empty message associations while preserving existing execution history', async () => {
  const { props } = fixture()
  const empty: StandInInboxWork = {
    id: 'empty',
    taskId: 'empty',
    roleId: 'default',
    title: 'Moved messages',
    status: 'sent',
    messageCount: 0,
    latestMessage: null,
    updatedAt: '2026-10-24T00:00:00Z',
    source: {
      id: 'group',
      name: 'Test group',
      kind: 'group',
      profile: 'corp:user',
      policy: { automatic: false, askBeforeAct: true },
    },
  }
  vi.mocked(props.services.standInApi!.inbox).mockResolvedValue({
    items: [
      empty,
      {
        ...empty,
        id: 'history',
        taskId: 'history',
        task: {
          taskId: 'history',
          title: 'Completed work',
          runtime: 'codex',
          status: 'completed',
          running: false,
          workspacePath: '',
          updatedAt: empty.updatedAt,
        },
      },
    ],
    sourceErrors: [],
  })
  render(<StandInOverviewPage {...props} />)
  await userEvent.click(await screen.findByTestId('stand-in-overview-role-default'))
  expect(await screen.findByTestId('stand-in-activity-task-history')).toHaveTextContent(
    'Completed work'
  )
  expect(screen.queryByTestId('stand-in-activity-task-empty')).not.toBeInTheDocument()
})

it('starts in the primary conversation and opens its editable profile explicitly', async () => {
  const { props, personalAgents, personalSave } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('primary')
  expect(screen.queryByTestId('stand-in-activity')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
  expect(personalAgents).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-settings-open'))
  expect(await screen.findByTestId('stand-in-primary-profile')).toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-primary-cancel'))
  expect(await screen.findByTestId('stand-in-overview')).toBeInTheDocument()
  expect(personalSave).not.toHaveBeenCalled()
})

it.each(['primary', 'role', 'memory'] as const)(
  'closes the unchanged %s drawer when clicking outside',
  async panel => {
    const { props } = fixture()
    const user = userEvent.setup()
    render(<StandInOverviewPage {...props} />)
    await screen.findByTestId('stand-in-overview-role-default')
    if (panel === 'role') await user.click(screen.getByTestId('stand-in-overview-role-default'))
    await user.click(
      screen.getByTestId(panel === 'memory' ? 'stand-in-memory-open' : 'stand-in-settings-open')
    )
    const content =
      panel === 'memory'
        ? 'stand-in-memory-panel'
        : panel === 'primary'
          ? 'stand-in-primary-profile'
          : 'stand-in-settings'
    await screen.findByTestId(content)
    fireEvent.click(screen.getByTestId('stand-in-profile-backdrop'))
    expect(screen.queryByTestId('stand-in-profile-panel')).not.toBeInTheDocument()
  }
)

it('keeps the drawer open when a text selection ends outside it', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await screen.findByTestId('stand-in-overview-role-default')
  await user.click(screen.getByTestId('stand-in-settings-open'))
  fireEvent.mouseDown(await screen.findByTestId('stand-in-primary-profile'))
  const backdrop = screen.getByTestId('stand-in-profile-backdrop')
  fireEvent.mouseUp(backdrop)
  fireEvent.click(backdrop)
  expect(screen.getByTestId('stand-in-profile-panel')).toBeInTheDocument()
  await user.click(backdrop)
  expect(screen.queryByTestId('stand-in-profile-panel')).not.toBeInTheDocument()
})

it.each(['primary', 'role', 'create', 'memory'] as const)(
  'uses a modal to protect unsaved %s drawer changes on outside clicks',
  async panel => {
    const { props, personalSave } = fixture()
    const user = userEvent.setup()
    render(<StandInOverviewPage {...props} />)
    await screen.findByTestId('stand-in-overview-role-default')
    if (panel === 'role') await user.click(screen.getByTestId('stand-in-overview-role-default'))
    await user.click(
      screen.getByTestId(
        panel === 'memory'
          ? 'stand-in-memory-open'
          : panel === 'create'
            ? 'stand-in-create-role'
            : 'stand-in-settings-open'
      )
    )
    if (panel === 'memory') await user.click(await screen.findByTestId('stand-in-memory-add'))
    const field = await screen.findByTestId(
      panel === 'primary'
        ? 'stand-in-preferences'
        : panel === 'memory'
          ? 'stand-in-memory-content'
          : 'stand-in-role-name'
    )
    await user.type(field, '保留这些修改')
    expect(
      screen.queryByRole('dialog', { name: '有未保存的修改，是否放弃？' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-profile-backdrop'))
    const dialog = screen.getByRole('dialog', { name: '有未保存的修改，是否放弃？' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('button', { name: '继续编辑' })).toHaveFocus()
    expect(within(dialog).getByText('放弃后，未保存的修改将丢失。')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '继续编辑' }))
    expect(field).toHaveValue('保留这些修改')
    expect(screen.getByTestId('stand-in-profile-panel')).toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-profile-backdrop'))
    await user.keyboard('{Escape}')
    expect(
      screen.queryByRole('dialog', { name: '有未保存的修改，是否放弃？' })
    ).not.toBeInTheDocument()
    expect(field).toHaveValue('保留这些修改')
    await user.click(screen.getByTestId('stand-in-profile-backdrop'))
    await user.click(
      within(screen.getByRole('dialog', { name: '有未保存的修改，是否放弃？' })).getByRole(
        'button',
        { name: '放弃修改' }
      )
    )
    expect(screen.queryByTestId('stand-in-profile-panel')).not.toBeInTheDocument()
    expect(personalSave).not.toHaveBeenCalled()
  }
)

it('groups actual stand-in executions by project, excludes ordinary tasks, and opens the selected execution', async () => {
  const { props } = fixture()
  props.projects.unshift({
    id: '12',
    name: 'Unrelated local project',
    project_store: 'local',
  } as CollaborationProject)
  const onOpenTask = vi.fn()
  const ordinary = {
    ...runtimeItem,
    key: 'ordinary',
    task: {
      ...runtimeItem.task,
      taskId: 'ordinary',
      title: 'Ordinary task',
      runtimeHandle: { origin: { initiatedBy: 'user' } },
    },
  }
  const completed = {
    ...runtimeItem,
    task: { ...runtimeItem.task, status: 'done', running: false },
  }
  const context = {
    runtimeTaskReminders: { items: [ordinary, completed] },
  } as unknown as WorkbenchContextValue
  const user = userEvent.setup()
  render(
    <WorkbenchContext.Provider value={context}>
      <StandInOverviewPage {...props} onOpenTask={onOpenTask} />
    </WorkbenchContext.Provider>
  )
  await user.click(await screen.findByTestId('stand-in-overview-role-default'))
  const group = await screen.findByTestId('stand-in-activity-project')
  expect(group).toHaveTextContent('Example project')
  expect(group).not.toHaveTextContent('Unrelated local project')
  expect(group).toHaveTextContent('已完成')
  expect(screen.queryByText('Ordinary task')).not.toBeInTheDocument()
  await user.click(within(group).getByTestId('stand-in-activity-task-task'))
  expect(onOpenTask).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-work-preview')).toHaveTextContent('Review')
  await user.click(screen.getByTestId('stand-in-preview-open'))
  expect(onOpenTask).toHaveBeenCalledWith(runtimeItem.address)
})

it('preserves the mounted conversation when settings refresh fails', async () => {
  const { props } = fixture()
  const api = props.services.standInApi!
  const settings = await api.personalGet(7, 'device')
  render(<StandInOverviewPage {...props} />)
  const conversation = await screen.findByTestId('identity-conversation')
  await screen.findByTestId('stand-in-overview-role-default')
  vi.mocked(api.personalGet).mockRejectedValue(new Error('settings unavailable'))
  act(() => publishPersonalStandIn(settings))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '分身操作失败，请稍后重试；如仍失败，请查看执行设备日志。'
  )
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
  vi.mocked(api.personalGet).mockResolvedValue(settings)
  await userEvent.click(screen.getByTestId('stand-in-overview-inline-retry'))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
})
