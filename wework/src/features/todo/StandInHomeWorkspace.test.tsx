import type { PersonalStandInSettings } from '@/api/personalStandIn'
import type { CollaborationProject, WorkspaceMyWorkItem } from '@wegent/collaboration'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { StandInInboxWork } from '@/api/standIn'
import i18n from '@/i18n'
import { StandInHomeWorkspace } from './StandInHomeWorkspace'

const conversation = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/navigation', () => ({ navigateTo: navigate }))
vi.mock('@/components/layout/workspace-panels/TemporaryChatPanel', () => ({
  TemporaryChatPanel: (props: { controlledAddress: { taskId: string }; active: boolean }) => {
    conversation(props)
    return (
      <input
        aria-label={`Task ${props.controlledAddress.taskId}`}
        data-active={String(props.active)}
      />
    )
  },
}))
afterEach(() => {
  cleanup()
  conversation.mockClear()
  navigate.mockClear()
})

function work(id: string): StandInInboxWork {
  return {
    id,
    taskId: id,
    roleId: '@primary',
    title: `Work ${id}`,
    status: 'sent',
    updatedAt: '2026-11-12T10:00:00Z',
    messageCount: 1,
    source: { name: 'Project Alpha' },
    latestMessage: { text: 'Original request' },
    task: {
      taskId: id,
      title: `Work ${id}`,
      status: 'done',
      running: false,
      updatedAt: '2026-11-12T10:00:00Z',
      runtimeHandle: {
        origin: {
          initiatedBy: 'stand_in',
          userId: 7,
          cloudProjectId: 'project',
          loopItemId: `issue-${id}`,
          projectStore: 'cloud',
          standInId: '@primary',
        },
      },
    },
  } as StandInInboxWork
}
async function setup(items: StandInInboxWork[], overrides = {}) {
  await i18n.changeLanguage('en')
  const api = {
    inbox: vi.fn().mockResolvedValue({ items, sourceErrors: [] }),
    processingStatus: vi.fn().mockResolvedValue({ running: false, pendingCount: 0, actions: [] }),
    ...overrides,
  }
  const props = {
    services: { standInApi: api } as unknown as WorkbenchServices,
    userId: 7,
    deviceId: 'bound',
    localDeviceId: 'local',
    active: true,
    settings: {
      userId: 7,
      executionDeviceId: 'bound',
      version: 1,
      primary: {
        enabled: true,
        collaboration: {
          enabled: true,
          allProjects: true,
          projects: [],
          excludedProjects: [],
          tags: [],
        },
      },
      roles: [{ id: 'reviewer', name: 'Reviewer' }],
    } as PersonalStandInSettings,
    projects: [
      { id: 'project', name: 'Project Alpha', project_store: 'backend' },
    ] as CollaborationProject[],
    onOpenTask: vi.fn(),
  }
  return { ...render(<StandInHomeWorkspace {...props} />), props, api }
}

it('defaults to Issue work and continues the original task inline while retaining drafts', async () => {
  const { props } = await setup([work('one'), work('two')])
  await screen.findByText('Work one')
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.queryByTestId('personal-home-general-chat')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-work-one'))
  expect(conversation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      controlledAddress: { deviceId: 'bound', taskId: 'one' },
      active: true,
      markReadWhenActive: true,
      sendEphemeral: false,
    })
  )
  expect(props.onOpenTask).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Task one'), { target: { value: 'Keep task draft' } })
  fireEvent.click(screen.getByTestId('personal-home-work-back'))
  expect(screen.getByLabelText('Task one')).toHaveAttribute('data-active', 'false')
  fireEvent.click(screen.getByTestId('personal-home-work-one'))
  expect(screen.getByLabelText('Task one')).toHaveValue('Keep task draft')
})

it('excludes non-Issue work, other owners and projects in the other store', async () => {
  const general = work('general')
  general.task!.runtimeHandle!.origin = { initiatedBy: 'stand_in', standInId: '@primary' }
  const other = work('other')
  other.task!.runtimeHandle!.origin = { ...other.task!.runtimeHandle!.origin, userId: 8 }
  const local = work('local')
  local.task!.runtimeHandle!.origin = {
    ...local.task!.runtimeHandle!.origin,
    projectStore: 'local',
  }
  await setup([work('issue'), general, other, local])
  await screen.findByText('Work issue')
  for (const id of ['general', 'other', 'local'])
    expect(screen.queryByText(`Work ${id}`)).not.toBeInTheDocument()
})

it('shows inbox failures and retries through a local recovery entry', async () => {
  const inbox = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ items: [work('restored')], sourceErrors: [] })
  await setup([], { inbox })
  fireEvent.click(await screen.findByTestId('personal-home-work-retry'))
  await screen.findByText('Work restored')
})

it('groups work by role with active and terminal tasks in separate sections', async () => {
  const active = work('active')
  active.roleId = 'reviewer'
  active.task = { ...active.task!, status: 'running', running: true }
  const failed = work('failed')
  failed.task = { ...failed.task!, status: 'failed', running: false }
  await setup([active, work('completed'), failed])
  await screen.findByText('Work active')
  expect(screen.getByTestId('personal-home-role-reviewer-processing')).toHaveTextContent(
    'Work active'
  )
  expect(screen.getByTestId('personal-home-role-@primary-completed')).toHaveTextContent(
    'Work completed'
  )
  expect(screen.getByTestId('personal-home-role-@primary-completed')).toHaveTextContent(
    'Work failed'
  )
  expect(screen.getByTestId('personal-home-role-@primary-processing')).not.toHaveTextContent(
    'Work completed'
  )
})

it('keeps connection guidance until an enabled identity includes an accessible board and exposes assistant settings', async () => {
  const { props, rerender } = await setup([])
  rerender(
    <StandInHomeWorkspace
      {...props}
      settings={{
        ...props.settings,
        primary: {
          ...props.settings.primary!,
          collaboration: {
            ...props.settings.primary!.collaboration!,
            allProjects: false,
            projects: [],
          },
        },
      }}
    />
  )
  expect(screen.getByTestId('personal-home-setup')).toBeInTheDocument()
  rerender(<StandInHomeWorkspace {...props} />)
  expect(screen.queryByTestId('personal-home-setup')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('personal-home-assistant-settings'))
  expect(navigate).toHaveBeenCalledWith('/stand-in?profileId=@primary')
  rerender(
    <StandInHomeWorkspace
      {...props}
      settings={{
        ...props.settings,
        primary: {
          ...props.settings.primary!,
          collaboration: {
            ...props.settings.primary!.collaboration!,
            excludedProjects: [{ id: 'project', store: 'cloud' }],
          },
        },
      }}
    />
  )
  expect(screen.getByTestId('personal-home-setup')).toBeInTheDocument()
})

it('uses collaboration Issues for Needs my input and opens their original details', async () => {
  const { props, rerender } = await setup([work('task')])
  const issue = {
    id: 'human',
    title: 'Collaboration decision',
    human_requests: [{ status: 'pending', question: 'Which release?' }],
  } as WorkspaceMyWorkItem
  const onOpenIssue = vi.fn()
  rerender(
    <StandInHomeWorkspace {...props} collaborationWork={{ pendingIssues: [issue], onOpenIssue }} />
  )
  expect(screen.getByTestId('personal-home-collaboration-pending')).toHaveTextContent(
    'Which release?'
  )
  expect(screen.getByTestId('personal-home-collaboration-pending')).not.toHaveTextContent(
    'Work task'
  )
  fireEvent.click(screen.getByTestId('personal-home-pending-human'))
  expect(onOpenIssue).toHaveBeenCalledWith(issue)
})
