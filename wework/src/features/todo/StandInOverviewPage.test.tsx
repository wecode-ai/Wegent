import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { newStandInRole, type StandInRole } from '@/api/personalStandIn'
import type { StandInInboxWork } from '@/api/standIn'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import '@/i18n'
import { StandInOverviewPage } from './StandInOverviewPage'

vi.mock('./StandInConversation', () => ({
  StandInConversation: ({ roleId }: { roleId?: string }) => (
    <div data-testid="identity-conversation">{roleId ?? 'primary'}</div>
  ),
}))

function fixture(roles: StandInRole[] = [newStandInRole('device', 'default')]) {
  const personalAgents = vi.fn(async () => [])
  const personalSave = vi.fn(async (_user, value) => value)
  const props = {
    userId: 7,
    api: {} as SharedWorkspaceApi,
    devices: [],
    projects: [
      { id: '12', name: 'Example project', project_store: 'backend' },
    ] as CollaborationProject[],
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'device' }),
      standInApi: {
        personalGet: vi.fn(async () => ({
          userId: 7,
          executionDeviceId: 'device',
          version: 0,
          autoSelect: false,
          roles,
        })),
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

it('opens the selected stand-in from the overview list', async () => {
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
  await user.click(screen.getByTestId('stand-in-settings-open'))
  expect(await screen.findByRole('combobox', { name: '当前分身' })).toHaveValue('second')
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
