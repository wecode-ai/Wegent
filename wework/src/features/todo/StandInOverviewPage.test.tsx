import {
  newStandInRole,
  publishPersonalStandIn,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { StandInInboxWork, StandInProposal } from '@/api/standIn'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import { WORKSPACE_NAVIGATION_EVENT } from '@/lib/navigation'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  runnerModelKey,
  type CollaborationProject,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { expect, it, vi } from 'vitest'
import { StandInConversation } from './StandInConversation'
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
  StandInConversation: vi.fn(
    ({
      roleId,
      draftRequest,
      contentFooter,
    }: {
      roleId?: string
      draftRequest?: { text: string }
      contentFooter?: import('react').ReactNode
    }) => (
      <div data-testid="identity-conversation">
        {roleId ?? 'primary'}
        {draftRequest?.text}
        {contentFooter}
      </div>
    )
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
        onboarding: vi.fn(async () => ({ state: { version: 1, completed: true } })),
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
    expect(await screen.findByRole('status')).toHaveTextContent('正在读取助理功能设置')
    expect(screen.queryByTestId('stand-in-onboarding')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stand-in-overview-role-default')).not.toBeInTheDocument()
    expect(screen.queryByTestId('identity-conversation')).not.toBeInTheDocument()
    // Install the device-scoped subscription before publishing a reload event.
    await act(async () => resolveInitial(settings))
    expect(await screen.findByTestId('stand-in-overview')).toBeInTheDocument()
    expect(screen.getByTestId('stand-in-overview-status')).toBeInTheDocument()
    return { api, settings, conversation: screen.getByTestId('identity-conversation') }
  } finally {
    await act(async () => resolveInitial(settings))
  }
}

async function navigationEntry(id: string): Promise<HTMLElement> {
  const existing = screen.queryByTestId(id)
  if (existing) return existing
  if (id === 'stand-in-memory-open' || id === 'stand-in-create-role') {
    await userEvent.click(await navigationEntry('stand-in-settings-open'))
  } else {
    const trigger = await screen.findByTestId('stand-in-details-open')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
  }
  return screen.findByTestId(id)
}

async function openRoles() {
  const selector = await screen.findByTestId('stand-in-role-selector')
  await waitFor(() => expect(screen.getByTestId('stand-in-details-open')).toBeEnabled())
  expect(selector).toBeVisible()
}

it('returns immediately while settings refresh in the background and pauses hidden polling', async () => {
  const { props } = fixture()
  const view = render(<StandInOverviewPage {...props} initialDeviceId="device" />)
  await openRoles()
  const api = props.services.standInApi!
  expect(api.personalGet).toHaveBeenCalledOnce()
  const conversation = screen.getByTestId('identity-conversation')
  view.rerender(<StandInOverviewPage {...props} initialDeviceId="device" active={false} />)
  vi.mocked(api.inbox).mockClear()
  vi.mocked(api.proposal).mockClear()
  vi.useFakeTimers()
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000)
    })
    expect(api.inbox).not.toHaveBeenCalled()
    expect(api.proposal).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
  view.rerender(<StandInOverviewPage {...props} initialDeviceId="device" active />)
  vi.mocked(api.personalGet).mockImplementationOnce(() => new Promise(() => {}))
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_NAVIGATION_EVENT, {
        detail: { kind: 'task', contentRoute: '/stand-in' },
      })
    )
  })
  await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
})

it('returns to the bound primary device when reopening the active workspace from a remote role', async () => {
  const { props } = fixture()
  const onSelectLocation = vi.fn()
  render(
    <StandInOverviewPage
      {...props}
      initialDeviceId="remote"
      primaryDeviceId="mac"
      initialSelectedRoleId="default"
      onSelectLocation={onSelectLocation}
    />
  )
  await screen.findByTestId('identity-conversation')
  act(() => {
    window.dispatchEvent(
      new CustomEvent(WORKSPACE_NAVIGATION_EVENT, {
        detail: { kind: 'task', contentRoute: '/stand-in' },
      })
    )
  })
  await waitFor(() => expect(onSelectLocation).toHaveBeenCalledExactlyOnceWith('mac'))
})

it('handles primary and calendar entry requests received while the retained page was inactive', async () => {
  const { props } = fixture()
  const view = render(
    <StandInOverviewPage {...props} initialSelectedRoleId="default" entryRequestKey={0} />
  )
  await openRoles()
  expect(screen.getByTestId('identity-conversation')).toHaveTextContent('default')
  view.rerender(<StandInOverviewPage {...props} active={false} entryRequestKey={0} />)
  view.rerender(
    <StandInOverviewPage {...props} active entryRequestKey={1} entryRoute="/stand-in" />
  )
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('primary')
  view.rerender(<StandInOverviewPage {...props} active={false} entryRequestKey={1} />)
  view.rerender(
    <StandInOverviewPage
      {...props}
      active
      entryRequestKey={2}
      entryRoute="/stand-in?view=scheduled"
    />
  )
  expect(await screen.findByTestId('stand-in-calendar-connection')).toBeVisible()
  view.rerender(
    <StandInOverviewPage {...props} active entryRequestKey={3} entryRoute="/stand-in" />
  )
  await waitFor(() =>
    expect(screen.queryByTestId('stand-in-calendar-connection')).not.toBeInTheDocument()
  )
  await userEvent.click(await navigationEntry('stand-in-settings-open'))
  expect(await screen.findByTestId('stand-in-preferences')).toBeVisible()
})

it('keeps lifecycle controls in management and only exposes details in the role header', async () => {
  const { props } = fixture()
  render(
    <StandInOverviewPage
      {...props}
      headerActions={<button data-testid="instance-stop-fixture">停止分身</button>}
    />
  )
  await openRoles()
  const header = screen.getByTestId('stand-in-role-selector').closest('header')!
  expect(within(header).queryByTestId('instance-stop-fixture')).not.toBeInTheDocument()
  expect(within(header).queryByTestId('stand-in-settings-open')).not.toBeInTheDocument()
  expect(within(header).getByTestId('stand-in-details-open')).toBeVisible()
  await userEvent.click(await navigationEntry('stand-in-settings-open'))
  const picker = await screen.findByTestId('instance-stop-fixture')
  expect(screen.getByTestId('stand-in-primary-footer-leading')).toContainElement(picker)
  const settingsPanel = screen.getByTestId('stand-in-profile-panel')
  expect(within(settingsPanel).queryByText('查看与管理')).not.toBeInTheDocument()
  expect(within(settingsPanel).queryByTestId('stand-in-guide-open')).not.toBeInTheDocument()
  expect(within(settingsPanel).queryByTestId('stand-in-role-chat')).not.toBeInTheDocument()
  expect(within(settingsPanel).queryByTestId('stand-in-primary-enabled')).not.toBeInTheDocument()
  expect(within(settingsPanel).getByTestId('stand-in-memory-open')).toHaveTextContent('记忆')
  expect(screen.getByTestId('stand-in-settings-tools')).not.toContainElement(picker)
  expect(within(header).getByTestId('stand-in-create-role')).toBeVisible()
  expect(within(header).getByTestId('stand-in-primary-open')).toBeVisible()
})

it('keeps an existing primary binding read-only while role devices are independent', async () => {
  const { props } = fixture()
  render(<StandInOverviewPage {...props} primaryDeviceId="mac" />)
  await openRoles()
  await userEvent.click(await navigationEntry('stand-in-settings-open'))
  await screen.findByTestId('stand-in-preferences')
  expect(screen.queryByTestId('stand-in-device')).not.toBeInTheDocument()
})

it('returns to the bound primary device after deleting a role on another device', async () => {
  const { props } = fixture([{ ...newStandInRole('device', 'review'), name: 'Review' }])
  const onSelectLocation = vi.fn()
  render(
    <StandInOverviewPage
      {...props}
      initialDeviceId="device"
      initialSelectedRoleId="review"
      primaryDeviceId="mac"
      onSelectLocation={onSelectLocation}
    />
  )
  await screen.findByTestId('identity-conversation')
  await userEvent.click(await navigationEntry('stand-in-settings-open'))
  await userEvent.click(await screen.findByTestId('stand-in-role-delete'))
  await userEvent.click(screen.getByTestId('stand-in-role-delete-confirm'))
  await waitFor(() => expect(onSelectLocation).toHaveBeenCalledExactlyOnceWith('mac'))
})

it('opens a scheduled activity in an editor dialog while preserving the profile and main chat', async () => {
  const { props } = fixture()
  props.services.automationApi = {
    listAutomations: vi.fn(async () => ({
      items: [
        {
          id: 'release-watch',
          name: '关注正式发布',
          enabled: true,
          updatedAt: '2026-11-08T12:00:00Z',
          timezone: 'Asia/Shanghai',
          schedule: { type: 'interval', value: 1, unit: 'hours' },
          taskRequest: {
            deviceId: 'device',
            standInOwner: { userId: 7, roleId: '@primary' },
            standInCalendar: {},
          },
        },
      ],
    })),
  } as unknown as NonNullable<WorkbenchServices['automationApi']>
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await openRoles()
  const conversation = screen.getByTestId('identity-conversation')
  await user.click(screen.getByTestId('stand-in-details-open'))
  const activity = await screen.findByTestId('stand-in-details-schedule-release-watch')
  await user.click(activity)
  expect(screen.getByTestId('stand-in-schedule-dialog')).toBeVisible()
  expect(screen.getByTestId('stand-in-details-popover')).toHaveAttribute('inert')
  expect(screen.queryByTestId('stand-in-primary-profile')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-details-activity')).not.toBeInTheDocument()
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
  await user.click(screen.getByTestId('stand-in-schedule-dialog-close'))
  expect(screen.queryByTestId('stand-in-schedule-dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-details-popover')).not.toHaveAttribute('inert')
  await waitFor(() => expect(activity).toHaveFocus())
})

it('reopens usage examples after onboarding without recreating a scheduled review', async () => {
  const { props } = fixture([])
  render(<StandInOverviewPage {...props} />)
  await openRoles()
  const user = userEvent.setup()
  await user.click(await navigationEntry('stand-in-guide-open'))
  expect(await screen.findByRole('dialog', { name: '助理使用示例' })).toBeVisible()
  expect(screen.getByTestId('stand-in-onboarding-example-daily_brief')).toBeVisible()
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-onboarding-example-weekly_review')).toBeVisible()
  expect(screen.queryByTestId('stand-in-onboarding-complete')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-onboarding-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-details-open')).toBeEnabled()
})

it('selects the primary conversation and inserts the chosen example as an editable draft', async () => {
  const { props } = fixture()
  render(<StandInOverviewPage {...props} />)
  await openRoles()
  const user = userEvent.setup()
  await user.click(screen.getByTestId('stand-in-overview-role-default'))
  expect(screen.getByTestId('stand-in-overview-role-default')).toHaveAttribute(
    'aria-current',
    'page'
  )
  await user.click(await navigationEntry('stand-in-guide-open'))
  await user.click(await screen.findByTestId('stand-in-onboarding-example-meeting_prep'))
  expect(screen.getByTestId('stand-in-primary-open')).toHaveAttribute('aria-current', 'page')
  expect(screen.getByTestId('identity-conversation')).toHaveTextContent('下一场会议')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

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
  expect(within(row).getByText('默认助理')).toBeInTheDocument()
  expect(within(row).getByText('Downloads')).toBeInTheDocument()
  expect(row).toHaveTextContent('已连接 1 个项目')
  expect(row).toHaveTextContent('未开启')
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('primary')
})

it('opens settings for the selected stand-in and reflects its renamed identity', async () => {
  const first = { ...newStandInRole('device', 'first'), name: 'Coding' }
  const second: StandInRole = {
    ...newStandInRole('device', 'second'),
    name: 'Reviewer',
    model: { runtime: 'codex', provider: 'local', model_id: 'review-model' },
    modelOptions: { modelSelection: 'model', reasoning: 'high' },
  }
  const { props } = fixture([first, second])
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await openRoles()
  await user.click(await screen.findByTestId('stand-in-overview-role-second'))
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('second')
  expect(vi.mocked(StandInConversation).mock.lastCall?.[0]).toMatchObject({
    settings: second,
    services: props.services,
  })
  expect(screen.queryByTestId('stand-in-settings')).not.toBeInTheDocument()
  await user.click(await navigationEntry('stand-in-role-chat'))
  expect(await screen.findByTestId('stand-in-activity')).toHaveTextContent('尚无处理记录')
  await user.click(screen.getByTestId('stand-in-work-dialog-close'))
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('second')
  expect(screen.getByTestId('stand-in-details-open')).toHaveAccessibleName('助理详情')
  await user.click(await navigationEntry('stand-in-settings-open'))
  expect(screen.getByRole('dialog', { name: '设置' })).toBeInTheDocument()
  const name = await screen.findByRole('textbox', { name: '助理名称' })
  expect(name).toHaveValue('Reviewer')
  expect(screen.queryByTestId('stand-in-role-select')).not.toBeInTheDocument()
  await user.clear(name)
  await user.type(name, '代码审查')
  expect(vi.mocked(StandInConversation).mock.lastCall?.[0].settings).toMatchObject({
    name: 'Reviewer',
  })
  await user.click(screen.getByTestId('stand-in-save'))
  await openRoles()
  await waitFor(() =>
    expect(screen.getByTestId('stand-in-overview-role-second')).toHaveTextContent('代码审查')
  )
  expect(screen.getByTestId('stand-in-overview-role-first')).toHaveTextContent('Coding')
  expect(screen.getByTestId('identity-conversation')).toHaveTextContent('second')
  expect(vi.mocked(StandInConversation).mock.lastCall?.[0].settings).toMatchObject({
    name: '代码审查',
    model: second.model,
    modelOptions: second.modelOptions,
  })
  await user.click(await navigationEntry('stand-in-settings-open'))
  expect(await screen.findByRole('textbox', { name: '助理名称' })).toHaveValue('代码审查')
  await user.click(screen.getByTestId('stand-in-close'))
  await user.click(await navigationEntry('stand-in-memory-open'))
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
  await userEvent.click(await navigationEntry('stand-in-role-chat'))
  expect(await screen.findByTestId('stand-in-activity-task-history')).toHaveTextContent(
    'Completed work'
  )
  expect(screen.queryByTestId('stand-in-activity-task-empty')).not.toBeInTheDocument()
})

it('starts in the primary conversation and opens its editable profile explicitly', async () => {
  const { props, personalAgents, personalSave } = fixture()
  const api = props.services.standInApi!
  const model = { runtime: 'codex' as const, provider: 'openai', model_id: 'profile-model' }
  const nextModel = { ...model, model_id: 'next-profile-model' }
  const modelOptions = { modelSelection: 'model', reasoning: 'high' }
  const settings = await api.personalGet(7, 'device')
  settings.primary = { enabled: true, prompt: '', preferences: '', model, modelOptions }
  vi.spyOn(api, 'catalog').mockResolvedValue({
    models: [model, nextModel].map(identity => ({
      ...identity,
      label: identity.model_id,
      local_model_id: identity.model_id,
      account_label: 'Local account',
      is_default: identity === model,
      default_reasoning_effort: 'high',
      supported_reasoning_efforts: ['high', 'max'],
    })),
  })
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  expect(await screen.findByTestId('identity-conversation')).toHaveTextContent('primary')
  const conversationProps = () => vi.mocked(StandInConversation).mock.lastCall?.[0]
  expect(conversationProps()).toMatchObject({
    settings: { model, modelOptions },
    services: props.services,
  })
  expect(screen.queryByTestId('stand-in-activity')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
  expect(personalAgents).not.toHaveBeenCalled()
  await user.click(await navigationEntry('stand-in-settings-open'))
  expect(await screen.findByTestId('stand-in-primary-profile')).toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-primary-cancel'))
  expect(await screen.findByTestId('stand-in-overview')).toBeInTheDocument()
  expect(personalSave).not.toHaveBeenCalled()
  await user.click(await navigationEntry('stand-in-settings-open'))
  await user.click(await screen.findByTestId('model-selector-button'))
  await user.click(await screen.findByTestId('model-advanced-toggle'))
  await user.click(await screen.findByTestId(`model-option-${runnerModelKey(nextModel)}`))
  await user.click(await screen.findByTestId('model-control-reasoning-max'))
  await user.click(screen.getByTestId('model-selector-button'))
  expect(conversationProps()?.settings).toMatchObject({ model, modelOptions })
  expect(personalSave).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-primary-save'))
  await waitFor(() =>
    expect(conversationProps()?.settings).toMatchObject({
      model: nextModel,
      modelOptions: { modelSelection: 'model', reasoning: 'max' },
    })
  )
  expect(personalSave).toHaveBeenCalledWith(
    7,
    expect.objectContaining({ primary: conversationProps()?.settings }),
    'device'
  )
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
      await navigationEntry(panel === 'memory' ? 'stand-in-memory-open' : 'stand-in-settings-open')
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
  await user.click(await navigationEntry('stand-in-settings-open'))
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
      await navigationEntry(
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
  await user.click(await navigationEntry('stand-in-role-chat'))
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
  expect(screen.queryByTestId('stand-in-work-dialog')).not.toBeInTheDocument()
})

it('preserves the mounted conversation when settings refresh fails', async () => {
  const { props } = fixture()
  const { api, settings, conversation } = await renderLoadedOverview(props)
  await openRoles()
  await screen.findByTestId('stand-in-overview-role-default')
  vi.mocked(api.personalGet).mockRejectedValue(new Error('settings unavailable'))
  act(() => publishPersonalStandIn(settings))
  await waitFor(() => expect(api.personalGet).toHaveBeenCalledTimes(3))
  await userEvent.click(await navigationEntry('stand-in-status-open'))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '未能加载助理设置。请检查执行设备是否在线，再点击「重新加载」。'
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
  await userEvent.click(await navigationEntry('stand-in-status-open'))
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
  const conversation = await screen.findByTestId('identity-conversation')
  const status = await navigationEntry('stand-in-status-open')
  expect(
    within(screen.getByTestId('stand-in-details-popover')).getByText('连接或运行需要处理')
  ).toBeVisible()
  expect(
    within(screen.getByTestId('stand-in-details-popover')).queryByText('Example group')
  ).not.toBeInTheDocument()
  await user.click(status)
  expect(screen.getByText('Example group')).toBeInTheDocument()
  const guidance = await screen.findByText(/来源所需插件尚未安装/)
  expect(guidance).toHaveTextContent('「连接」')
  expect(guidance).toHaveTextContent('「安装所需插件」')
  expect(guidance).toHaveTextContent('安装后重新加载')
  expect(screen.queryByText('Dependency dingtalk is missing')).not.toBeInTheDocument()
  expect(retrySource).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-source-retry-group-1'))
  expect(retrySource).toHaveBeenCalledWith(7, 'device', source)
  await waitFor(() => expect(screen.queryByText(/来源所需插件尚未安装/)).not.toBeInTheDocument())
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
  expect(screen.queryByTestId('stand-in-status-open')).not.toBeInTheDocument()
})

it('keeps attention work in the work list instead of stacking duplicate cards above the conversation', async () => {
  const { props } = fixture()
  const waiting = {
    ...runtimeItem,
    task: { ...runtimeItem.task, interactionStatus: 'awaitingUserReply' as const },
  }
  const context = {
    runtimeTaskReminders: { items: [waiting] },
  } as unknown as WorkbenchContextValue
  render(
    <WorkbenchContext.Provider value={context}>
      <StandInOverviewPage {...props} />
    </WorkbenchContext.Provider>
  )
  const conversation = await screen.findByTestId('identity-conversation')
  expect(screen.queryByTestId('stand-in-work-attention-count')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-important-work')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-attention-task')).not.toBeInTheDocument()
  await userEvent.click(await navigationEntry('stand-in-role-chat'))
  expect(await screen.findByTestId('stand-in-activity-task-task')).toBeVisible()
  expect(screen.getByTestId('identity-conversation')).toBe(conversation)
})

it('opens a pending configuration explicitly without resolving it when the dialog is closed', async () => {
  const { props } = fixture()
  const api = props.services.standInApi!
  const current = await api.personalGet(7, 'device')
  const proposal = {
    id: 'pending-configuration',
    summary: 'Follow only projects with a confirmed owner',
    settings: { ...current, roles: [] },
  } as StandInProposal
  vi.mocked(api.proposal).mockResolvedValue(proposal)
  api.resolveProposal = vi.fn(async () => ({ ...current }))
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await screen.findByTestId('identity-conversation')
  const entry = await navigationEntry('stand-in-proposal-open')
  expect(
    within(screen.getByTestId('identity-conversation')).getByTestId('stand-in-proposal')
  ).toHaveTextContent(proposal.summary)
  await user.click(entry)
  expect(await screen.findByTestId('stand-in-proposal')).toHaveTextContent(proposal.summary)
  await user.click(screen.getByTestId('stand-in-proposal-dialog-close'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(
    within(screen.getByTestId('identity-conversation')).getByTestId('stand-in-proposal')
  ).toBeVisible()
  expect(api.resolveProposal).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-details-open')).toHaveFocus()
  await user.click(await navigationEntry('stand-in-proposal-open'))
  await user.click(screen.getByTestId('stand-in-proposal-accept'))
  expect(api.resolveProposal).toHaveBeenCalledWith(7, 'device', proposal.id, true)
})

it('keeps an outdated configuration visibly unconfirmable inside the review dialog', async () => {
  const { props } = fixture()
  const api = props.services.standInApi!
  const current = await api.personalGet(7, 'device')
  vi.mocked(api.proposal).mockResolvedValue({
    id: 'old-configuration',
    summary: 'An outdated proposal',
    settings: { ...current, version: current.version - 1 },
  } as StandInProposal)
  api.resolveProposal = vi.fn()
  render(<StandInOverviewPage {...props} />)
  await userEvent.click(await navigationEntry('stand-in-proposal-open'))
  expect(screen.getByTestId('stand-in-proposal-accept')).toBeDisabled()
  expect(screen.getByTestId('stand-in-proposal-reject')).toBeEnabled()
  await userEvent.click(screen.getByTestId('stand-in-proposal-dialog-close'))
  expect(api.resolveProposal).not.toHaveBeenCalled()
})

it('keeps a failed inline proposal editable and shows an applied receipt only after saving succeeds', async () => {
  const { props } = fixture()
  const api = props.services.standInApi!
  const current = await api.personalGet(7, 'device')
  const proposal = {
    id: 'inline-save',
    roleId: null,
    status: 'pending',
    summary: 'Add Platform group to the reply role',
    settings: { ...current, roles: [{ ...current.roles[0]!, name: 'Group replies' }] },
  } as StandInProposal
  vi.mocked(api.proposal).mockResolvedValue(proposal)
  api.resolveProposal = vi
    .fn()
    .mockRejectedValueOnce(new Error('Save failed'))
    .mockResolvedValueOnce({ ...proposal.settings, version: current.version + 1 })
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await user.click(await screen.findByTestId('stand-in-proposal-accept'))
  expect(
    await within(screen.getByTestId('identity-conversation')).findByRole('alert')
  ).toHaveTextContent('暂时无法完成此操作。请保留当前修改，重新加载后再试。')
  expect(screen.queryByTestId('stand-in-proposal-result')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-proposal-accept')).toBeEnabled()
  await user.click(screen.getByTestId('stand-in-proposal-accept'))
  expect(await screen.findByTestId('stand-in-proposal-result')).toHaveTextContent('Group replies')
  expect(screen.queryByTestId('stand-in-proposal-accept')).not.toBeInTheDocument()
})

it('does not resurrect a settled proposal when an older poll finishes after confirmation', async () => {
  vi.useFakeTimers()
  try {
    const { props } = fixture()
    const api = props.services.standInApi!
    const current = await api.personalGet(7, 'device')
    const proposal = {
      id: 'late-poll',
      roleId: null,
      status: 'pending',
      summary: 'Update role',
      settings: { ...current, roles: [{ ...current.roles[0]!, name: 'Updated role' }] },
    } as StandInProposal
    let resolvePoll!: (value: StandInProposal) => void
    vi.mocked(api.proposal)
      .mockResolvedValueOnce(proposal)
      .mockImplementation(
        () =>
          new Promise(resolve => {
            resolvePoll = resolve
          })
      )
    api.resolveProposal = vi.fn(async () => ({ ...proposal.settings, version: 1 }))
    await act(async () => {
      render(<StandInOverviewPage {...props} />)
    })
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(api.proposal).toHaveBeenCalledTimes(2)
    await act(async () => {
      fireEvent.click(screen.getByTestId('stand-in-proposal-accept'))
    })
    await act(async () => {
      resolvePoll(proposal)
    })
    expect(screen.queryByTestId('stand-in-proposal')).not.toBeInTheDocument()
    expect(screen.getByTestId('stand-in-proposal-result')).toHaveTextContent('配置已应用')
    expect(api.resolveProposal).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('retains a save failure when background polling successfully rereads the same draft', async () => {
  vi.useFakeTimers()
  try {
    const { props } = fixture()
    const api = props.services.standInApi!
    const current = await api.personalGet(7, 'device')
    vi.mocked(api.proposal).mockResolvedValue({
      id: 'save-failure',
      roleId: null,
      status: 'pending',
      summary: 'Pending change',
      settings: current,
    } as StandInProposal)
    api.resolveProposal = vi.fn().mockRejectedValue(new Error('save unavailable'))
    await act(async () => {
      render(<StandInOverviewPage {...props} />)
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('stand-in-proposal-accept'))
    })
    const conversation = within(screen.getByTestId('identity-conversation'))
    expect(conversation.getByRole('alert')).toBeVisible()
    await act(async () => {
      vi.advanceTimersByTime(3000)
    })
    expect(api.proposal).toHaveBeenCalledTimes(2)
    expect(conversation.getByRole('alert')).toBeVisible()
    expect(conversation.getByTestId('stand-in-proposal-accept')).toBeEnabled()
    expect(screen.queryByTestId('stand-in-proposal-result')).not.toBeInTheDocument()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps unsaved settings mounted when the menu requests scheduled work', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await user.click(await navigationEntry('stand-in-settings-open'))
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
  await user.click(await navigationEntry('stand-in-memory-open'))
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
  await waitFor(() => expect(screen.getByTestId('stand-in-details-open')).toBeEnabled())
})

it('keeps saved settings accessible while explicit navigation refreshes configuration', async () => {
  const { props } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  await navigationEntry('stand-in-memory-open')
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
  await user.click(await navigationEntry('stand-in-settings-open'))
  expect(screen.getByTestId('stand-in-profile-panel')).toBeVisible()
  await act(async () => finish(settings))
})

it('saves the primary identity through the existing settings flow before finishing first-use setup', async () => {
  const { props, personalSave } = fixture([])
  const api = props.services.standInApi!
  vi.mocked(api.onboarding).mockImplementation(
    async () =>
      ({ state: { version: 1, completed: false } }) as Awaited<ReturnType<typeof api.onboarding>>
  )
  const completeOnboarding = vi.fn(async () => ({ state: { version: 1, completed: true } }))
  Object.assign(api, { completeOnboarding })
  render(<StandInOverviewPage {...props} />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-onboarding-continue'))
  expect(personalSave).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-onboarding-complete'))
  await screen.findByTestId('identity-conversation')
  expect(personalSave).toHaveBeenCalledWith(
    7,
    expect.objectContaining({
      executionDeviceId: 'device',
      primary: expect.objectContaining({ enabled: true }),
      roles: [],
    }),
    'device'
  )
  expect(completeOnboarding).toHaveBeenCalledWith(7, 'device', false, '09:00', expect.any(String))
  expect(personalSave.mock.invocationCallOrder[0]).toBeLessThan(
    completeOnboarding.mock.invocationCallOrder[0]
  )
})

it('keeps first-use setup open when the existing settings save fails and allows retry', async () => {
  const { props, personalSave } = fixture([])
  const api = props.services.standInApi!
  vi.mocked(api.onboarding).mockImplementation(
    async () =>
      ({ state: { version: 1, completed: false } }) as Awaited<ReturnType<typeof api.onboarding>>
  )
  const completeOnboarding = vi.fn(async () => ({ state: { version: 1, completed: true } }))
  Object.assign(api, { completeOnboarding })
  personalSave.mockRejectedValueOnce(new Error('Settings save unavailable'))
  render(<StandInOverviewPage {...props} />)
  const user = userEvent.setup()
  await user.click(await screen.findByTestId('stand-in-onboarding-continue'))
  await user.click(screen.getByTestId('stand-in-onboarding-complete'))
  expect(await screen.findByTestId('stand-in-onboarding-settings-retry')).toBeVisible()
  expect(completeOnboarding).not.toHaveBeenCalled()
  expect(screen.getByTestId('stand-in-onboarding-summary')).toBeVisible()
  await user.click(screen.getByTestId('stand-in-onboarding-complete'))
  await screen.findByTestId('identity-conversation')
  expect(completeOnboarding).toHaveBeenCalledOnce()
})

it('keeps profile recovery and creation reachable when the selected device and onboarding are offline', async () => {
  const { props } = fixture()
  vi.mocked(props.services.standInApi!.personalGet).mockRejectedValue(new Error('Executor offline'))
  vi.mocked(props.services.standInApi!.onboarding).mockRejectedValue(new Error('Executor offline'))
  render(<StandInOverviewPage {...props} initialDeviceId="offline-cloud" />)
  await screen.findByTestId('stand-in-overview-retry')
  expect(screen.queryByTestId('stand-in-onboarding')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-create-role')).toBeEnabled()
  expect(screen.getByTestId('stand-in-details-open')).toBeEnabled()
})
