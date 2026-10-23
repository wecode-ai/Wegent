import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { newStandInRole } from '@/api/personalStandIn'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { runtimeItem } from '@/features/notifications/standInNotifications.fixtures'
import '@/i18n'
import { StandInOverviewPage } from './StandInOverviewPage'

function fixture() {
  const personalAgents = vi.fn(async () => [])
  const personalSave = vi.fn(async (_user, value) => value)
  const personalGet = vi.fn(async () => ({
    userId: 7,
    executionDeviceId: 'device',
    version: 0,
    autoSelect: false,
    roles: [newStandInRole('device', 'default')],
  }))
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
        personalGet,
        personalSave,
        personalAgents,
      },
    } as unknown as WorkbenchServices,
  }
  return { props, personalAgents, personalSave, personalGet }
}

it('shows state and work history first, and opens settings only after an explicit action', async () => {
  const { props, personalAgents, personalSave } = fixture()
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)
  expect(await screen.findByTestId('stand-in-overview-status')).toHaveTextContent('未开启')
  expect(screen.getByTestId('stand-in-activity')).toHaveTextContent('尚无处理记录')
  expect(screen.queryByTestId('stand-in-agent')).not.toBeInTheDocument()
  expect(personalAgents).not.toHaveBeenCalled()
  await user.click(screen.getByTestId('stand-in-settings-open'))
  expect(await screen.findByTestId('stand-in-agent')).toBeInTheDocument()
  await user.click(screen.getByTestId('stand-in-cancel'))
  expect(await screen.findByTestId('stand-in-overview')).toBeInTheDocument()
  expect(personalSave).not.toHaveBeenCalled()
})

it('groups actual stand-in executions by project, excludes ordinary tasks, and opens the selected execution', async () => {
  const { props } = fixture()
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
  const group = await screen.findByTestId('stand-in-activity-project')
  expect(group).toHaveTextContent('Example project')
  expect(group).toHaveTextContent('已完成')
  expect(screen.queryByText('Ordinary task')).not.toBeInTheDocument()
  await user.click(within(group).getByTestId('stand-in-activity-task-task'))
  expect(onOpenTask).toHaveBeenCalledWith(runtimeItem.address)
})

it('explains an outdated Executor at the top level and recovers after retry', async () => {
  const { props, personalGet } = fixture()
  personalGet.mockRejectedValueOnce(
    new Error('runtime_rpc_failed: Unsupported runtime RPC method: runtime.stand_in.personal.get')
  )
  const user = userEvent.setup()
  render(<StandInOverviewPage {...props} />)

  const error = await screen.findByRole('alert')
  expect(error).toHaveTextContent('Wework 版本过旧')
  expect(error).not.toHaveTextContent('runtime.stand_in.personal.get')

  await user.click(screen.getByTestId('stand-in-overview-retry'))
  expect(await screen.findByTestId('stand-in-overview-status')).toHaveTextContent('未开启')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})
