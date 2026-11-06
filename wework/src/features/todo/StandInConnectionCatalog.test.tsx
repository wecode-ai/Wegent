import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CollaborationProject } from '@wegent/collaboration'
import { newStandInRole, type StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor } from '@/api/standIn'
import '@/i18n'
import { StandInConnectionCatalog } from './StandInConnectionCatalog'

const provider = (id: string, status = 'ready'): ConnectionProviderDescriptor => ({
  id,
  displayName: id,
  availability: { status },
  resourceKinds: ['group'],
  dependencies: [],
})
const connection = (id: string, providerId = 'chat'): StandInSourceConnection => ({
  id,
  providerId,
  name: `群聊 ${id}`,
  profile: 'account',
  kind: 'group',
  policy: { automatic: true, askBeforeAct: true },
})
const defaults = {
  role: {
    ...newStandInRole('mac'),
    collaboration: { ...newStandInRole('mac').collaboration, allProjects: false },
  },
  projects: [],
  providers: [],
  loading: false,
  disabled: false,
  scheduling: true,
  onSelect: vi.fn(),
}

it('shows a plugin scope summary without displaying its opaque collection key', () => {
  render(
    <StandInConnectionCatalog
      {...defaults}
      providers={[provider('chat')]}
      role={{
        ...defaults.role,
        connections: [
          {
            ...connection('one'),
            collectionKey: 'opaque-selection-key',
            configurationSummary: 'Selected item #4335',
          },
        ],
      }}
    />
  )
  const row = screen.getByTestId('stand-in-add-chat-connection')
  expect(row).toHaveTextContent('Selected item #4335')
  expect(row).not.toHaveTextContent('opaque-selection-key')
})

it('groups multiple resources under one source and keeps other sources available', async () => {
  const role = { ...defaults.role, connections: [connection('one'), connection('two')] }
  const onSelect = vi.fn()
  render(
    <StandInConnectionCatalog
      {...defaults}
      role={role}
      providers={[provider('chat'), provider('mail')]}
      onSelect={onSelect}
    />
  )
  const configured = within(screen.getByTestId('stand-in-connected-list'))
  expect(configured.getAllByRole('button')).toHaveLength(1)
  const row = configured.getByRole('button')
  expect(row).toHaveTextContent('群聊 one · 群聊 two')
  expect(row).toHaveTextContent('已配置接收范围')
  expect(screen.getByTestId('stand-in-add-mail-connection')).toBeVisible()
  expect(screen.getByTestId('stand-in-time-connections')).toBeVisible()
  expect(screen.queryByTestId('stand-in-add-connection')).not.toBeInTheDocument()
  await userEvent.setup().click(row)
  expect(onSelect).toHaveBeenCalledWith('chat')
})

it.each([
  ['auth_required', '需要登录授权', '登录授权'],
  ['dependency_missing', '需要安装依赖插件', '安装所需插件'],
  ['plugin_disabled', '连接插件已停用', '查看详情'],
])('shows the next step for a configured source in state %s', (status, message, action) => {
  render(
    <StandInConnectionCatalog
      {...defaults}
      role={{ ...defaults.role, connections: [connection('one')] }}
      providers={[provider('chat', status)]}
    />
  )
  const row = screen.getByTestId('stand-in-add-chat-connection')
  expect(row).toHaveTextContent('群聊 one')
  expect(row).toHaveTextContent(message)
  expect(row).toHaveTextContent(action)
  expect(row).not.toHaveTextContent('已配置接收范围')
})

it('keeps configured resources accessible when the provider disappears', async () => {
  const onSelect = vi.fn()
  const view = render(
    <StandInConnectionCatalog
      {...defaults}
      loading
      role={{ ...defaults.role, connections: [connection('one')] }}
      onSelect={onSelect}
    />
  )
  expect(screen.getByTestId('stand-in-add-chat-connection-status')).toHaveTextContent('加载')
  view.rerender(
    <StandInConnectionCatalog
      {...defaults}
      role={{ ...defaults.role, connections: [connection('one')] }}
      onSelect={onSelect}
    />
  )
  expect(screen.getByTestId('stand-in-add-chat-connection')).toHaveTextContent('群聊 one')
  expect(screen.getByTestId('stand-in-add-chat-connection-status')).toHaveTextContent(
    '连接暂不可用'
  )
  await userEvent.setup().click(screen.getByTestId('stand-in-add-chat-connection'))
  expect(onSelect).toHaveBeenCalledWith('chat')
})

it('summarizes projects with the same id in different stores without losing their identities', () => {
  const role = {
    ...defaults.role,
    collaboration: {
      ...defaults.role.collaboration,
      enabled: true,
      allProjects: false,
      projects: [
        { id: 'one', store: 'local' as const },
        { id: 'one', store: 'cloud' as const },
      ],
    },
  }
  const projects = [
    { id: 'one', name: '本地项目', project_store: 'local' },
    { id: 'one', name: '云端项目', project_store: 'backend' },
  ] as CollaborationProject[]
  render(<StandInConnectionCatalog {...defaults} role={role} projects={projects} />)
  expect(within(screen.getByTestId('stand-in-connected-list')).getAllByRole('button')).toHaveLength(
    1
  )
  expect(screen.getByTestId('stand-in-connection-project-local-one')).toHaveTextContent('本地项目')
  expect(screen.getByTestId('stand-in-connection-project-cloud-one')).toHaveTextContent('云端项目')
})

it('does not confuse an available provider with a configured scope and honors disabled controls', () => {
  render(<StandInConnectionCatalog {...defaults} providers={[provider('chat')]} disabled />)
  expect(screen.queryByTestId('stand-in-connected-list')).not.toBeInTheDocument()
  expect(screen.getByTestId('stand-in-add-chat-connection-status')).toHaveTextContent(
    '尚未配置接收范围'
  )
  expect(screen.getByTestId('stand-in-add-chat-connection')).toBeDisabled()
})

it.each([true, false])(
  'retains the configured project scope when receiving is off (allProjects=%s)',
  allProjects => {
    const role = {
      ...defaults.role,
      collaboration: {
        ...defaults.role.collaboration,
        enabled: false,
        allProjects,
        projects: allProjects ? [] : [{ id: 'kept', store: 'local' as const }],
      },
    }
    render(<StandInConnectionCatalog {...defaults} role={role} />)
    const row = within(screen.getByTestId('stand-in-connected-list')).getByRole('button')
    expect(row).toHaveTextContent('未开启接收')
    expect(row).toHaveTextContent(allProjects ? '所有参与的项目' : 'kept')
    expect(row).toHaveTextContent('查看配置')
  }
)

it('directs remote authorization to the selected execution device', () => {
  render(
    <StandInConnectionCatalog
      {...defaults}
      providers={[provider('chat', 'auth_required')]}
      local={false}
    />
  )
  expect(screen.getByTestId('stand-in-add-chat-connection')).toHaveTextContent('在执行设备上授权')
})

it('searches source names and configured scopes, and recovers from an empty result', async () => {
  const user = userEvent.setup()
  render(
    <StandInConnectionCatalog
      {...defaults}
      role={{ ...defaults.role, connections: [connection('Design', 'chat')] }}
      providers={[provider('chat'), provider('mail')]}
    />
  )
  const search = screen.getByRole('searchbox')
  await user.type(search, 'design')
  expect(screen.getByTestId('stand-in-add-chat-connection')).toBeVisible()
  expect(screen.queryByTestId('stand-in-add-mail-connection')).not.toBeInTheDocument()
  expect(screen.queryByTestId('stand-in-time-connections')).not.toBeInTheDocument()
  await user.clear(search)
  await user.type(search, 'unknown')
  expect(screen.getByRole('status')).toHaveTextContent('没有匹配的连接')
  await user.clear(search)
  expect(screen.getByTestId('stand-in-add-mail-connection')).toBeVisible()
  expect(screen.getByTestId('stand-in-time-connections')).toBeVisible()
})

it('filters configured sources without changing scope, and restores the full catalog', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(
    <StandInConnectionCatalog
      {...defaults}
      role={{ ...defaults.role, connections: [connection('one'), connection('two')] }}
      providers={[provider('chat'), provider('mail')]}
      onSelect={onSelect}
    />
  )
  const filter = screen.getByTestId('stand-in-connection-configured-filter')
  expect(filter).toHaveTextContent('已配置 1')
  await user.click(filter)
  expect(filter).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByTestId('stand-in-add-chat-connection')).toBeVisible()
  expect(screen.queryByTestId('stand-in-available-list')).not.toBeInTheDocument()
  expect(onSelect).not.toHaveBeenCalled()
  await user.click(filter)
  expect(screen.getByTestId('stand-in-add-mail-connection')).toBeVisible()
})

it('keeps the full catalog reachable when no source is configured', async () => {
  const user = userEvent.setup()
  render(<StandInConnectionCatalog {...defaults} providers={[provider('chat')]} />)
  const filter = screen.getByTestId('stand-in-connection-configured-filter')
  await user.click(filter)
  expect(screen.getByRole('status')).toHaveTextContent('还没有已配置的来源')
  await user.click(filter)
  expect(screen.getByTestId('stand-in-add-chat-connection')).toBeVisible()
})
