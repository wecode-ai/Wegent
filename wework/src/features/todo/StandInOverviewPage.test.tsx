import {
  newStandInRole,
  publishPersonalStandIn,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { StandInInboxWork } from '@/api/standIn'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { WORKSPACE_NAVIGATION_EVENT } from '@/lib/navigation'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { expect, it, vi } from 'vitest'
import { StandInOverviewPage } from './StandInOverviewPage'
const menuMocks = vi.hoisted(() => ({ leave: vi.fn((action: () => void) => action()) }))
vi.mock('@/features/automations/AutomationsPage', async () => {
  const { useImperativeHandle } = await import('react')
  return {
    AutomationsPage: ({
      ref,
      onDirtyChange,
    }: {
      ref: import('react').Ref<unknown>
      onDirtyChange?(dirty: boolean): void
    }) => {
      useImperativeHandle(ref, () => ({ requestLeave: menuMocks.leave }))
      return (
        <button data-testid="scheduled-work-fixture" onClick={() => onDirtyChange?.(true)}>
          编辑安排
        </button>
      )
    },
  }
})
function requestScheduledWork() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_NAVIGATION_EVENT, {
        detail: { kind: 'task', contentRoute: '/stand-in?view=scheduled' },
      })
    )
  })
}
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
        processingStatus: vi.fn(async () => ({ pendingCount: 0, running: false, actions: [] })),
        personalSave,
        personalAgents,
      },
    } as unknown as WorkbenchServices,
  }
  return { props, personalAgents, personalSave }
}

async function renderLoadedOverview(props: ReturnType<typeof fixture>['props']) {
  const api = props.services.standInApi!
  const settings = await api.personalGet(7, 'device')
  let resolveInitial!: (value: typeof settings) => void
  vi.mocked(api.personalGet).mockReturnValueOnce(
    new Promise<typeof settings>(done => {
      resolveInitial = done
    })
  )
  render(<StandInOverviewPage {...props} />)
  try {
    await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('stand-in-overview')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-overview-status')).toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-overview-role-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('identity-conversation')).not.toBeInTheDocument()
    // Install the device-scoped subscription before publishing a reload event.
    await act(async () => resolveInitial(settings))
    return { api, settings, conversation: screen.getByTestId('identity-conversation') }
  } finally {
    await act(async () => resolveInitial(settings))
  }
}

async function openRoles() {
  const selector = await screen.findByTestId('stand-in-role-selector')
  await waitFor(() => expect(screen.getByTestId('stand-in-settings-open')).toBeEnabled())
  expect(selector).toBeVisible()
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
  await openRoles()
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
  await openRoles()
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
  await openRoles()
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
  const { api, settings, conversation } = await renderLoadedOverview(props)
  let resolve!: (value: typeof settings) => void
  const pending = new Promise<typeof settings>(done => {
    resolve = done
  })
  try {
    vi.mocked(api.personalGet).mockReturnValueOnce(pending)
    act(() => publishPersonalStandIn(settings))
    await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(3))
    expect(screen.getByTestId('identity-conversation')).toBe(conversation)
    await act(async () => resolve(settings))
    expect(screen.getByTestId('identity-conversation')).toBe(conversation)
  } finally {
    await act(async () => resolve(settings))
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
  await openRoles()
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
    await openRoles()
    await screen.findByTestId('stand-in-overview-role-default')
    await openRoles()
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
  await openRoles()
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
    await openRoles()
    await screen.findByTestId('stand-in-overview-role-default')
    await openRoles()
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
  await openRoles()
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
  const { api, settings, conversation } = await renderLoadedOverview(props)
  await openRoles()
  await screen.findByTestId('stand-in-overview-role-default')
  vi.mocked(api.personalGet).mockRejectedValue(new Error('settings unavailable'))
  act(() => publishPersonalStandIn(settings))
  await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(3))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '未能加载分身设置。请检查执行设备是否在线，再点击「重新加载」。'
  )
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
  vi.mocked(api.personalGet).mockResolvedValue(settings)
  await userEvent.click(screen.getByTestId('stand-in-overview-inline-retry'))
  await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(4))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
})

it('routes a pending background confirmation to its real Runtime task', async () => {
  const { props } = fixture()
  const api = props.services.standInApi!
  const settings = await api.personalGet(7, 'device')
  vi.mocked(api.personalGet).mockResolvedValue({
    ...settings,
  })
  api.processingStatus = vi.fn().mockResolvedValue({
    pendingCount: 1,
    running: true,
    awaitingUser: true,
    taskId: 'stand-in-coordinator-7',
    actions: [],
  })
  const onOpenTask = vi.fn()
  render(<StandInOverviewPage {...props} onOpenTask={onOpenTask} />)
  await userEvent.click(await screen.findByTestId('stand-in-processing-open-task'))
  expect(onOpenTask).toHaveBeenCalledWith({
    taskId: 'stand-in-coordinator-7',
    deviceId: 'device',
    runtime: 'codex',
  })
})

it('shows plugin installation guidance for a failed source and clears it after reloading', async () => {
  const { props } = fixture()
  const source = {
    providerId: 'dingtalk',
    id: 'group-1',
    profile: 'default',
    name: 'Example group',
    kind: 'group',
    policy: { automatic: false, askBeforeAct: true },
  }
  const inbox = vi.mocked(props.services.standInApi.inbox)
  inbox.mockResolvedValue({
    items: [],
    sourceErrors: [
      { source, error: { code: 'dependency_missing', message: 'Dependency dingtalk is missing' } },
    ],
  })
  const retrySource = vi.fn(async () => {
    inbox.mockResolvedValue({ items: [], sourceErrors: [] })
  })
  props.services.standInApi.retrySource = retrySource
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  const guidance = await screen.findByText(/Example group · 来源所需插件尚未安装/)
  expect(guidance).toHaveTextContent('「连接」')
  expect(guidance).toHaveTextContent('「安装所需插件」')
  expect(guidance).toHaveTextContent('安装后重新加载')
  expect(screen.queryByText('Dependency dingtalk is missing')).not.toBeInTheDocument()
  expect(retrySource).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-source-retry-group-1'))
  expect(retrySource).toHaveBeenCalledWith(7, 'device', source)
  await waitFor(() =>
    expect(screen.queryByText(/Example group · 来源所需插件尚未安装/)).not.toBeInTheDocument()
  )
})

it('keeps unsaved settings mounted when the menu requests scheduled work', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await user.click(await screen.findByTestId('stand-in-settings-open'))
  const field = await screen.findByTestId('stand-in-preferences')
  await user.type(field, '保留菜单切换前的草稿')
  requestScheduledWork()
  expect(screen.getByTestId('stand-in-preferences')).toBe(field)
  expect(field).toHaveValue('保留菜单切换前的草稿')
  await user.click(screen.getByTestId('stand-in-profile-backdrop'))
  expect(screen.getByRole('dialog', { name: '有未保存的修改，是否放弃？' })).toBeInTheDocument()
})

it('waits for the primary settings before mounting a calendar deep link', async () => {
  const { props } = fixture()
  const getSettings = vi.mocked(props.services.standInApi!.personalGet)
  const settings = await getSettings(7, 'device')
  getSettings.mockClear()
  let finishLoading!: () => void
  getSettings.mockImplementationOnce(
    () => new Promise(resolve => (finishLoading = () => resolve(settings)))
  )
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} initialWorkView="scheduled" />)
  await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1))
  expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-calendar-connection')).not.toBeInTheDocument()
  await act(async () => finishLoading())
  const primary = await screen.findByTestId('stand-in-primary-profile')
  expect(screen.getByTestId('stand-in-calendar-connection')).toBeVisible()
  await user.click(screen.getByTestId('stand-in-connections-back'))
  expect(await screen.findByTestId('stand-in-time-connections')).toBeVisible()
  expect(screen.getByTestId('stand-in-primary-profile')).toBe(primary)
  expect(screen.queryByTestId('stand-in-calendar-connection')).not.toBeInTheDocument()
})

it('opens the calendar as a connection and protects its draft on every repeated menu request', async () => {
  const { props } = fixture()
  render(<StandInOverviewPage {...props} />)
  await openRoles()
  await screen.findByTestId('stand-in-overview-role-default')
  expect(screen.queryByTestId('stand-in-work-view-scheduled')).not.toBeInTheDocument()
  requestScheduledWork()
  expect(await screen.findByTestId('stand-in-calendar-connection')).toBeInTheDocument()
  expect(screen.getByTestId('stand-in-primary-profile')).toHaveTextContent('连接')
  expect(screen.getByTestId('stand-in-primary-save')).toBeVisible()
  const calendar = screen.getByTestId('stand-in-calendar-connection')
  menuMocks.leave.mockImplementationOnce(() => {})
  const before = menuMocks.leave.mock.calls.length
  requestScheduledWork()
  expect(menuMocks.leave).toHaveBeenCalledTimes(before + 1)
  expect(screen.getByTestId('stand-in-calendar-connection')).toBe(calendar)
  menuMocks.leave.mockImplementationOnce(() => {})
  requestScheduledWork()
  expect(menuMocks.leave).toHaveBeenCalledTimes(before + 2)
  requestScheduledWork()
  expect(await screen.findByTestId('stand-in-calendar-connection')).not.toBe(calendar)
})

it('reopens the same role settings for a new explicit project entry request', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  const view = render(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="first" />
  )
  await screen.findByTestId('stand-in-role-name')
  await user.click(screen.getByTestId('stand-in-cancel'))
  expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument()
  view.rerender(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="second" />
  )
  expect(await screen.findByTestId('stand-in-role-name')).toHaveValue('')
})

it('locates the requested role after a different role was selected inside the page', async () => {
  const other = { ...newStandInRole('device', 'other'), name: 'Other role' }
  const { props } = fixture([newStandInRole('device', 'default'), other])
  const user = userEvent.setup()
  const view = render(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="first" />
  )
  await user.click(await screen.findByTestId('stand-in-cancel'))
  await openRoles()
  await user.click(screen.getByTestId('stand-in-overview-role-other'))
  view.rerender(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="second" />
  )
  expect(await screen.findByTestId('stand-in-role-name')).toHaveValue('')
  expect(screen.getByTestId('stand-in-overview-role-default')).toHaveAttribute(
    'aria-current',
    'page'
  )
})

it('guards a dirty memory panel before a new explicit settings request', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  const view = render(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="first" />
  )
  await user.click(await screen.findByTestId('stand-in-cancel'))
  await user.click(screen.getByTestId('stand-in-memory-open'))
  await user.click(await screen.findByTestId('stand-in-memory-add'))
  const field = await screen.findByTestId('stand-in-memory-content')
  await user.type(field, 'Keep this memory draft')
  view.rerender(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="second" />
  )
  expect(screen.getByTestId('stand-in-memory-content')).toBe(field)
  await user.click(await screen.findByTestId('stand-in-memory-keep'))
  expect(field).toHaveValue('Keep this memory draft')
  view.rerender(
    <StandInOverviewPage {...props} initialProfileId="default" settingsRequestKey="third" />
  )
  await user.click(await screen.findByTestId('stand-in-memory-discard'))
  expect(await screen.findByTestId('stand-in-role-name')).toHaveValue('')
})

it('refreshes external configuration and returns to the primary identity on explicit sidebar navigation', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  const api = props.services.standInApi!
  const settings = await api.personalGet(7, 'device')
  render(<StandInOverviewPage {...props} />)
  await openRoles()
  await user.click(await screen.findByTestId('stand-in-overview-role-default'))
  const external = { ...newStandInRole('device', 'external'), name: 'External configuration' }
  vi.mocked(api.personalGet).mockResolvedValue({
    ...settings,
    roles: [...settings.roles, external],
  })
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_NAVIGATION_EVENT, {
        detail: { kind: 'task', contentRoute: '/stand-in' },
      })
    )
  })
  await openRoles()
  expect(await screen.findByTestId('stand-in-overview-role-external')).toHaveTextContent(
    'External configuration'
  )
  expect(screen.getByTestId('stand-in-primary-open')).toHaveAttribute('aria-current', 'page')
  expect(screen.getByTestId('identity-conversation')).toHaveTextContent('primary')
  await waitFor(() => expect(screen.getByTestId('stand-in-settings-open')).toBeEnabled())
})

it('keeps saved settings accessible while explicit navigation refreshes configuration', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await waitFor(() => expect(screen.getByTestId('stand-in-memory-open')).toBeVisible())
  let finish!: (value: PersonalStandInSettings) => void
  const settings = await props.services.standInApi!.personalGet(7, 'device')
  vi.mocked(props.services.standInApi!.personalGet).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_NAVIGATION_EVENT, {
        detail: { kind: 'task', contentRoute: '/stand-in' },
      })
    )
  })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await user.click(screen.getByTestId('stand-in-settings-open'))
  expect(screen.getByTestId('stand-in-profile-panel')).toBeVisible()
  await act(async () => finish(settings))
})
