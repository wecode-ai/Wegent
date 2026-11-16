import type { CollaborationProject } from '@wegent/collaboration'
import { createRef } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { newStandInRole } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import '@/i18n'
import {
  StandInConnectionSettings,
  type StandInConnectionNavigationHandle,
} from './StandInConnectionSettings'

vi.mock('@/features/automations/AutomationsPage', () => ({
  AutomationsPage: () => <div data-testid="calendar-editor" />,
}))

const provider = (id: string, displayName: string): ConnectionProviderDescriptor => ({
  id,
  displayName,
  resourceKinds: ['folder'],
  resourceLabels: { folder: '文件夹' },
  dependencies: [],
  availability: { status: 'ready' },
})
const props = {
  role: newStandInRole('mac'),
  projects: [],
  deviceId: 'mac',
  localDeviceId: 'mac',
  disabled: false,
  onChange: vi.fn(),
}

it('discovers independent connection plugins and routes resource searches to the selected provider', async () => {
  const searchConnectionResources = vi.fn(async () => ({ items: [] }))
  const api = {
    connectionProviders: vi.fn(async () => ({
      items: [provider('@test/mail/inbox', '邮箱'), provider('@test/calendar/events', '日历')],
    })),
    searchConnectionResources,
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} api={api} />)
  await user.click(await screen.findByTestId('stand-in-add-@test/mail/inbox-connection'))
  await user.type(screen.getByTestId('stand-in-connection-@test/mail/inbox-query'), 'Inbox')
  await user.click(screen.getByTestId('stand-in-connection-@test/mail/inbox-search'))
  expect(searchConnectionResources).toHaveBeenCalledWith(
    'mac',
    '@test/mail/inbox',
    'folder',
    'Inbox',
    undefined
  )
})

it('installs dependencies only after the user clicks the installation action', async () => {
  const item = {
    ...provider('@test/mail/inbox', '邮箱'),
    availability: { status: 'dependency_missing' },
    dependencies: [{ alias: 'mail', status: 'missing' }],
  }
  const installConnectionDependencies = vi.fn(async () => {})
  const api = {
    connectionProviders: vi.fn(async () => ({ items: [item] })),
    installConnectionDependencies,
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} api={api} />)
  await user.click(await screen.findByTestId('stand-in-add-@test/mail/inbox-connection'))
  const install = await screen.findByTestId('stand-in-install-dependencies-@test/mail/inbox')
  expect(installConnectionDependencies).not.toHaveBeenCalled()
  await user.click(install)
  expect(installConnectionDependencies).toHaveBeenCalledWith('mac', '@test/mail/inbox', ['mail'])
})

it('does not apply a previous device catalog after changing the selected device', async () => {
  let finish!: (value: { items: ConnectionProviderDescriptor[] }) => void
  const api = {
    connectionProviders: vi
      .fn()
      .mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve
        })
      )
      .mockResolvedValue({ items: [provider('@test/new/inbox', '新设备邮箱')] }),
  } as unknown as StandInExecutorApi
  const view = render(<StandInConnectionSettings {...props} api={api} />)
  view.rerender(<StandInConnectionSettings {...props} api={api} deviceId="other" />)
  await screen.findByText('新设备邮箱')
  await act(async () => finish({ items: [provider('@test/old/inbox', '旧设备邮箱')] }))
  expect(screen.queryByText('旧设备邮箱')).not.toBeInTheDocument()
})

it('offers the built-in calendar independently of configured sources', async () => {
  const user = userEvent.setup()
  const ref = createRef<StandInConnectionNavigationHandle>()
  render(
    <StandInConnectionSettings
      {...props}
      ref={ref}
      scheduling={{ userId: 7, roleId: '@primary' }}
    />
  )
  expect(screen.getByTestId('stand-in-time-connections')).toBeVisible()
  expect(screen.queryByTestId('stand-in-add-connection')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-connections-empty')).not.toBeInTheDocument()
  expect(screen.getAllByText('日历')).toHaveLength(1)
  expect(screen.queryByTestId('stand-in-add-time-connection')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-connection-type-picker')).toContainElement(
    screen.getByTestId('stand-in-time-connections')
  )
  await user.click(screen.getByTestId('stand-in-time-connections'))
  expect(screen.getByTestId('stand-in-calendar-connection')).toBeVisible()
  expect(screen.queryByTestId('stand-in-connections-back')).not.toBeInTheDocument()
  act(() => ref.current?.back())
  expect(screen.getByTestId('stand-in-time-connections')).toBeVisible()
})

it('shows source choices immediately and keeps installation mutually exclusive with selection while refreshing', async () => {
  const item = {
    ...provider('example', 'Example'),
    availability: { status: 'dependency_missing' },
    dependencies: [{ alias: 'example', status: 'missing' }],
  }
  let finish!: (value: { items: ConnectionProviderDescriptor[] }) => void
  const connectionProviders = vi
    .fn()
    .mockResolvedValueOnce({ items: [item] })
    .mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  const api = {
    connectionProviders,
    installConnectionDependencies: vi.fn(async () => {}),
  } as unknown as StandInExecutorApi
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} api={api} />)
  expect(screen.queryByTestId('stand-in-add-connection')).not.toBeInTheDocument()
  await user.click(await screen.findByTestId('stand-in-add-example-connection'))
  expect(screen.queryByTestId('stand-in-connection-example-add')).not.toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-install-dependencies-example'))
  expect(screen.queryByText('连接暂不可用，请检查插件和执行设备。')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-connection-example-query')).not.toBeInTheDocument()
  await act(async () =>
    finish({ items: [{ ...item, availability: { status: 'ready' }, dependencies: [] }] })
  )
  expect(await screen.findByTestId('stand-in-connection-example-query')).toBeVisible()
  expect(screen.queryByTestId('stand-in-install-dependencies-example')).not.toBeInTheDocument()
})

it.each(['@primary', 'reviewer'])(
  'uses the shared calendar policy for %s without an event-specific setting',
  async roleId => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const role = newStandInRole('mac', roleId)
    render(
      <StandInConnectionSettings
        {...props}
        role={role}
        onChange={onChange}
        initialCalendar
        scheduling={{ userId: 7, roleId }}
      />
    )
    expect(screen.getByTestId('stand-in-connection-header')).toBeVisible()
    expect(screen.getByTestId('stand-in-processing-settings')).toBeVisible()
    expect(screen.queryByTestId('stand-in-calendar-policy')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('stand-in-processing-settings-toggle'))
    expect(screen.getByTestId('stand-in-calendar-policy')).toHaveAttribute(
      'aria-checked',
      String(roleId !== '@primary')
    )
    await user.click(screen.getByTestId('stand-in-calendar-policy'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        calendar: {
          policy: { automatic: true, askBeforeAct: true, immediate: roleId === '@primary' },
        },
      })
    )
  }
)

it('shows pending connection changes until the saved configuration catches up', () => {
  const savedConfiguration = newStandInRole('mac')
  const role = {
    ...savedConfiguration,
    calendar: { policy: { automatic: true, askBeforeAct: true, immediate: true } },
  }
  const view = render(
    <StandInConnectionSettings {...props} role={role} savedConfiguration={savedConfiguration} />
  )
  expect(screen.getByTestId('stand-in-connections-pending')).toHaveTextContent('保存助理设置后生效')
  view.rerender(<StandInConnectionSettings {...props} role={role} savedConfiguration={role} />)
  expect(screen.queryByTestId('stand-in-connections-pending')).not.toBeInTheDocument()
})

it.each(['dependency_missing', 'plugin_disabled', 'dependency_incompatible', 'auth_required'])(
  'allows removing saved scope while the provider is %s',
  async status => {
    const item = { ...provider('chat', '消息'), availability: { status } }
    const api = {
      connectionProviders: vi.fn(async () => ({ items: [item] })),
    } as unknown as StandInExecutorApi
    const role = {
      ...props.role,
      connections: [
        {
          providerId: 'chat',
          profile: 'account',
          kind: 'folder',
          id: 'saved',
          name: '保留的范围',
          policy: { automatic: true, askBeforeAct: true },
        },
      ],
    }
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<StandInConnectionSettings {...props} role={role} api={api} onChange={onChange} />)
    await user.click(await screen.findByTestId('stand-in-add-chat-connection'))
    await user.click(
      await screen.findByTestId(
        status === 'auth_required'
          ? 'stand-in-connection-chat-remove-saved'
          : 'stand-in-disconnect-chat-saved'
      )
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ connections: [] }))
  }
)

it('allows preparing the all-project scope before joining a project without a misleading prerequisite', async () => {
  const role = { ...props.role, collaboration: { ...props.role.collaboration, enabled: true } }
  const user = userEvent.setup()
  render(<StandInConnectionSettings {...props} role={role} />)
  await user.click(screen.getByTestId('stand-in-add-projects-connection'))
  expect(screen.getByText('目前没有可选项目，之后加入的项目会自动纳入此范围。')).toBeVisible()
  expect(screen.queryByText('先创建或加入一个项目，再配置助理。')).not.toBeInTheDocument()
})

it.each([true, false])(
  'keeps paused project selections checked and disabled (allProjects=%s)',
  async allProjects => {
    const role = {
      ...props.role,
      collaboration: {
        ...props.role.collaboration,
        allProjects,
        projects: [{ id: 'one', store: 'local' as const }],
      },
    }
    const user = userEvent.setup()
    render(
      <StandInConnectionSettings
        {...props}
        role={role}
        projects={[
          { id: 'one', name: 'Selected project', project_store: 'local' } as CollaborationProject,
        ]}
      />
    )
    await user.click(screen.getByTestId('stand-in-add-projects-connection'))
    const checkbox = screen.getByRole('checkbox', { name: 'Selected project' })
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeDisabled()
  }
)
