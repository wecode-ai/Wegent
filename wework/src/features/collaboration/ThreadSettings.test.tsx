import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi, ThreadParticipation } from '@/api/chatGroups'
import { ThreadSettings } from './ThreadSettings'
import type { ThreadHierarchyRenderContext as ThreadSettingsHierarchyContext } from './threadHierarchy'
import { groupBoardContext } from './groupWorkspaceApi'

const group: ChatGroup = {
  id: 'group',
  project_key: 'G',
  name: 'Design',
  description: '',
  status: 'active',
  version: 1,
  role: 'Owner',
  created_by_user_id: 7,
  created_at: '2026-11-11T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
}
const item: CollaborationIssue = {
  id: 'G-1',
  cloud_project_id: 'group',
  sequence_number: 1,
  title: 'Review',
  description: '',
  status: 'pending',
  priority: 'none',
  parent_id: null,
  assignee_user_id: null,
  permissions: { edit_content: true, assign: true, comment: true, execute: true },
  created_by_user_id: 7,
  tags: [],
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: group.created_at,
  updated_at: group.updated_at,
  completed_at: null,
}
const participation: ThreadParticipation = {
  current_user_id: 7,
  participants: [{ user_id: 7, name: 'Owner', notifications: 'all' }],
  joined: true,
  can_comment: true,
  show_in_sidebar: true,
}

function setup(
  options: {
    linked?: boolean
    crewCatalog?: SharedWorkspaceApi['projects']['listCollaborationGroups']
    groupCrewCatalog?: SharedWorkspaceApi['projects']['listCollaborationGroups']
    execute?: boolean
    agentCatalog?: SharedWorkspaceApi['agents']['list']
    restricted?: boolean
    saveError?: Error
    linkError?: Error
    localPrincipal?: boolean
    role?: ChatGroup['role']
    projectCatalog?: Promise<import('@wegent/collaboration').CollaborationProject[]>
    renderHierarchy?: (context: ThreadSettingsHierarchyContext) => import('react').ReactNode
  } = {}
) {
  const project = { ...groupBoardContext(group, 'cloud'), id: 'project', name: 'Plan' }
  const initialItem =
    options.execute === false
      ? { ...item, permissions: { ...item.permissions!, execute: false } }
      : item
  let stored = initialItem
  const update = options.saveError
    ? vi.fn().mockRejectedValue(options.saveError)
    : vi.fn().mockImplementation(async (_id, input) => {
        const changes = Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined)
        )
        stored = {
          ...stored,
          ...changes,
          version: stored.version + 1,
          ...(input.milestoneId !== undefined ? { milestone_id: input.milestoneId } : {}),
          ...(input.assigneeUserId !== undefined ? { assignee_user_id: input.assigneeUserId } : {}),
          ...(input.assigneeAgentId !== undefined
            ? { assignee_agent_id: input.assigneeAgentId }
            : {}),
          ...(input.assigneeTeamId !== undefined ? { assignee_team_id: input.assigneeTeamId } : {}),
          ...(input.assigneeGroupId !== undefined
            ? { assignee_group_id: input.assigneeGroupId }
            : {}),
          ...(input.assigneeGroupSourceId !== undefined
            ? { assignee_group_source_id: input.assigneeGroupSourceId }
            : {}),
          ...(input.startAt !== undefined ? { start_at: input.startAt } : {}),
          ...(input.dueAt !== undefined ? { due_at: input.dueAt } : {}),
        }
        return stored
      })
  const issues = {
    get: vi
      .fn()
      .mockResolvedValue(
        options.saveError ? { ...item, title: 'Other user title', version: 2 } : initialItem
      ),
    update,
  }
  const groupCrews =
    options.groupCrewCatalog ?? options.crewCatalog ?? vi.fn().mockResolvedValue([])
  const api = {
    issues,
    projects: { listCollaborationGroups: groupCrews },
  } as unknown as SharedWorkspaceApi
  const milestoneList = vi
    .fn()
    .mockResolvedValue([{ id: 'milestone', title: 'Release', project_id: 'project' }])
  const catalog = {
    agents: { list: options.agentCatalog ?? vi.fn().mockResolvedValue([]) },
    projects: {
      list: vi.fn().mockResolvedValue(options.projectCatalog ?? [project]),
      listCollaborationGroups: options.crewCatalog ?? vi.fn().mockResolvedValue([]),
    },
    milestones: { list: milestoneList },
  } as unknown as SharedWorkspaceApi
  const projectLink = vi.fn().mockResolvedValue({
    thread_version: 1,
    project: options.linked ? { id: 'project', name: 'Plan' } : null,
    restricted: options.restricted ?? false,
  })
  const setProjectLink = options.linkError
    ? vi.fn().mockRejectedValue(options.linkError)
    : vi.fn().mockResolvedValue({ project: null, restricted: false, thread_version: 2 })
  const next = {
    ...participation,
    participants: [
      ...participation.participants,
      { user_id: 8, name: 'Member', notifications: 'all' },
    ],
  }
  const inviteParticipants = vi.fn().mockResolvedValue(next)
  const groups = { projectLink, setProjectLink, inviteParticipants } as unknown as ChatGroupApi
  const onChanged = vi.fn()
  const onParticipation = vi.fn()
  const onClose = vi.fn()
  const registerLeaveGuard = vi.fn()
  render(
    <ThreadSettings
      group={{ ...group, role: options.role ?? group.role }}
      project={groupBoardContext(group, 'cloud')}
      item={initialItem}
      items={[item]}
      members={[
        { user_id: 7, name: 'Owner', role: 'Owner' },
        { user_id: 8, name: 'Member', role: 'Developer' },
      ]}
      api={api}
      catalog={catalog}
      groups={groups}
      participation={
        options.localPrincipal
          ? {
              ...participation,
              current_user_id: 0,
              participants: [{ user_id: 0, name: 'Local', notifications: 'muted' }],
            }
          : participation
      }
      locale="zh-CN"
      onParticipation={onParticipation}
      onChanged={onChanged}
      onClose={onClose}
      registerLeaveGuard={registerLeaveGuard}
      renderHierarchy={options.renderHierarchy}
    />
  )
  return {
    update,
    milestoneList,
    setProjectLink,
    inviteParticipants,
    onParticipation,
    onChanged,
    next,
    onClose,
    issues,
    projectLink,
    registerLeaveGuard,
  }
}

describe('Thread settings domain boundaries', () => {
  it('reads native group crews from the actual group port without using the project crew catalog', async () => {
    const groupCrewCatalog = vi
      .fn()
      .mockResolvedValue([{ id: 'group-crew', name: 'Group delivery' }])
    const projectCrewCatalog = vi.fn().mockRejectedValue(new Error('Project catalog unavailable'))
    const view = setup({ groupCrewCatalog, crewCatalog: projectCrewCatalog })
    const option = await screen.findByRole('option', { name: '小组：Group delivery' })
    expect(groupCrewCatalog).toHaveBeenCalledWith('group')
    expect(projectCrewCatalog).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('thread-settings-assignee'), {
      target: { value: option.getAttribute('value') },
    })
    await waitFor(() =>
      expect(view.update).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ assigneeGroupId: 'group-crew', assigneeGroupSourceId: 'group' })
      )
    )
  })

  it('prevents execution assignments when execute permission is false while retaining human assignment', async () => {
    const view = setup({
      execute: false,
      agentCatalog: vi
        .fn()
        .mockResolvedValue([{ id: 'agent', name: 'Reviewer', status: 'active' }]),
      groupCrewCatalog: vi.fn().mockResolvedValue([{ id: 'crew', name: 'Delivery' }]),
    })
    expect(await screen.findByRole('option', { name: 'Reviewer' })).toBeDisabled()
    const crew = screen.getByRole('option', { name: '小组：Delivery' })
    expect(crew).toBeDisabled()
    fireEvent.change(screen.getByTestId('thread-settings-assignee'), {
      target: { value: 'agent:agent' },
    })
    fireEvent.change(screen.getByTestId('thread-settings-assignee'), {
      target: { value: crew.getAttribute('value') },
    })
    expect(view.update).not.toHaveBeenCalled()
    expect(
      within(screen.getByTestId('thread-settings-assignee')).getByRole('option', { name: 'Member' })
    ).not.toBeDisabled()
    fireEvent.change(screen.getByTestId('thread-settings-assignee'), {
      target: { value: 'user:8' },
    })
    await waitFor(() =>
      expect(view.update).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ assigneeUserId: 8 })
      )
    )
  })

  it('saves the selected crew ID and source atomically and clears both on human reassignment', async () => {
    const crewCatalog = vi.fn().mockResolvedValue([{ id: 'same', name: 'Delivery' }])
    const view = setup({ linked: true, crewCatalog })
    await screen.findAllByRole('option', { name: '小组：Delivery' })
    fireEvent.change(screen.getByTestId('thread-settings-assignee'), {
      target: { value: `crew:${JSON.stringify(['project', 'same'])}` },
    })
    await waitFor(() =>
      expect(view.update).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ assigneeGroupId: 'same', assigneeGroupSourceId: 'project' })
      )
    )
    fireEvent.change(screen.getByTestId('thread-settings-assignee'), {
      target: { value: 'user:8' },
    })
    await waitFor(() =>
      expect(view.update).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({
          assigneeUserId: 8,
          assigneeGroupId: null,
          assigneeGroupSourceId: null,
        })
      )
    )
  })

  it('keeps the authorized current project visible while the editable catalog is loading', async () => {
    let resolveCatalog!: (projects: import('@wegent/collaboration').CollaborationProject[]) => void
    const projectCatalog = new Promise<import('@wegent/collaboration').CollaborationProject[]>(
      resolve => {
        resolveCatalog = resolve
      }
    )
    setup({ linked: true, projectCatalog })
    const select = await screen.findByTestId('thread-project-select')
    expect(select).toHaveValue('project')
    expect(select).toHaveTextContent('Plan')
    expect(select).toBeDisabled()
    resolveCatalog([{ ...groupBoardContext(group, 'cloud'), id: 'project', name: 'Plan' }])
    await waitFor(() => expect(select).toBeEnabled())
    expect(select).toHaveValue('project')
    expect(screen.getAllByRole('option', { name: 'Plan' })).toHaveLength(1)
  })

  it('shows real participants without loading milestones or legacy collaborators for an unlinked group Thread', async () => {
    const { milestoneList } = setup()
    await screen.findByTestId('thread-project-select')
    expect(milestoneList).not.toHaveBeenCalled()
    expect(screen.getByTestId('thread-participants')).toHaveTextContent('1 人参与')
    expect(screen.queryByTestId('cloud-todo-collaborators')).not.toBeInTheDocument()
    expect(screen.getByTestId('thread-settings-priority')).toBeVisible()
    expect(screen.getByText('关联项目后，可选择该项目的里程碑。')).toBeVisible()
  })

  it('loads milestones only from the independently authorized linked project', async () => {
    const { milestoneList } = setup({ linked: true })
    await waitFor(() => expect(milestoneList).toHaveBeenCalledWith('project'))
    expect(milestoneList).not.toHaveBeenCalledWith('group')
    fireEvent.click(screen.getByTestId('thread-settings-milestone'))
    expect(await screen.findByTestId('thread-settings-milestone-option-milestone')).toBeVisible()
  })

  it('shows the chosen milestone and the cleared value in the closed picker', async () => {
    setup({ linked: true })
    const picker = await screen.findByTestId('thread-settings-milestone')
    await waitFor(() => expect(picker).toBeEnabled())
    expect(picker).toHaveTextContent('未设置')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByTestId('thread-settings-milestone-option-milestone'))
    await waitFor(() => expect(picker).toBeEnabled())
    expect(picker).toHaveTextContent('Release')
    fireEvent.click(picker)
    fireEvent.click(await screen.findByTestId('thread-settings-milestone-option-empty'))
    await waitFor(() => expect(picker).toBeEnabled())
    expect(picker).toHaveTextContent('未设置')
  })

  it('prevents removing a restricted project link without source project authority', async () => {
    const { setProjectLink } = setup({ restricted: true })
    const select = await screen.findByTestId('thread-project-select')
    expect(select).toHaveValue('__restricted__')
    expect(select).toBeDisabled()
    fireEvent.click(screen.getByTestId('thread-project-apply'))
    expect(setProjectLink).not.toHaveBeenCalled()
  })

  it('submits the displayed classification version and preserves the selection after conflict', async () => {
    const { setProjectLink, issues, onChanged, projectLink } = setup({
      linkError: new Error('Project changed'),
    })
    const select = await screen.findByTestId('thread-project-select')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Plan' })).toBeInTheDocument())
    issues.get.mockResolvedValue({ ...item, version: 99 })
    fireEvent.change(select, { target: { value: 'project' } })
    fireEvent.click(screen.getByTestId('thread-project-apply'))
    await waitFor(() => expect(setProjectLink).toHaveBeenCalledWith('G-1', 1, 'project'))
    expect(await screen.findByText('Project changed')).toBeVisible()
    expect(select).toHaveValue('project')
    expect(issues.get).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    projectLink.mockResolvedValue({
      project: { id: 'project', name: 'Plan' },
      restricted: false,
      thread_version: 99,
    })
    fireEvent.click(screen.getByTestId('thread-project-reload'))
    await waitFor(() => expect(screen.queryByText('Project changed')).not.toBeInTheDocument())
    expect(select).toHaveValue('project')
    expect(screen.getByTestId('thread-project-apply')).toBeDisabled()
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(screen.getByTestId('thread-project-apply'))
    await waitFor(() => expect(setProjectLink).toHaveBeenLastCalledWith('G-1', 99, null))
  })

  it('protects metadata drafts and keeps project classification separate from saving them', async () => {
    const { onClose } = setup()
    await screen.findByTestId('thread-project-select')
    fireEvent.change(screen.getByTestId('thread-settings-title'), {
      target: { value: 'Unsaved title' },
    })
    expect(screen.getByTestId('thread-project-select')).toBeDisabled()
    fireEvent.click(screen.getByTestId('thread-settings-close'))
    expect(onClose).not.toHaveBeenCalled()
    expect(await screen.findByRole('dialog')).toHaveTextContent('放弃未保存的修改')
    fireEvent.click(screen.getByTestId('thread-settings-discard'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows notification preferences for the server principal on a private local group', () => {
    setup({ localPrincipal: true })
    expect(screen.getByTestId('thread-notification-preference')).toHaveValue('muted')
  })

  it('keeps sidebar navigation pending until the user explicitly discards the draft', async () => {
    const { registerLeaveGuard } = setup()
    fireEvent.change(screen.getByTestId('thread-settings-title'), { target: { value: 'Unsaved' } })
    const navigate = vi.fn()
    const guard = registerLeaveGuard.mock.calls.at(-1)?.[0]
    expect(guard).toBeTypeOf('function')
    guard(navigate)
    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('thread-settings-discard'))
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('blocks closing and sidebar navigation while a metadata save is in flight', async () => {
    const { update, registerLeaveGuard, onClose, onChanged } = setup()
    let finish!: (value: CollaborationIssue) => void
    update.mockReturnValue(
      new Promise<CollaborationIssue>(resolve => {
        finish = resolve
      })
    )
    fireEvent.change(screen.getByTestId('thread-settings-title'), { target: { value: 'Saving' } })
    fireEvent.blur(screen.getByTestId('thread-settings-title'))
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(screen.getByTestId('thread-settings-close')).toBeDisabled()
    const navigate = vi.fn()
    registerLeaveGuard.mock.calls.at(-1)?.[0](navigate)
    expect(navigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    finish({ ...item, version: 2, title: 'Saving' })
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
  })

  it('invites only the selected group member and uses the server participation response', async () => {
    const { inviteParticipants, onParticipation, next } = setup()
    fireEvent.change(screen.getByTestId('thread-invite-member'), { target: { value: '8' } })
    fireEvent.click(screen.getByTestId('thread-invite-submit'))
    await waitFor(() => expect(inviteParticipants).toHaveBeenCalledWith('G-1', [8]))
    await waitFor(() => expect(onParticipation).toHaveBeenCalledWith(next))
  })

  it('keeps the user draft after a version conflict instead of closing settings', async () => {
    const { update, onChanged } = setup({
      saveError: Object.assign(new Error('Thread changed'), { status: 409 }),
    })
    fireEvent.change(screen.getByTestId('thread-settings-title'), {
      target: { value: 'My new title' },
    })
    fireEvent.blur(screen.getByTestId('thread-settings-title'))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(await screen.findByText('Thread changed')).toBeVisible()
    expect(screen.getByTestId('thread-settings-title')).toHaveValue('My new title')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('autosaves properties and Enter-committed title without submitting the description draft', async () => {
    const { update } = setup({ linked: true })
    await waitFor(() => expect(screen.getByTestId('thread-settings-milestone')).toBeEnabled())
    fireEvent.change(screen.getByTestId('thread-settings-description'), {
      target: { value: 'Draft description' },
    })
    fireEvent.change(screen.getByTestId('thread-settings-title'), { target: { value: 'Renamed' } })
    fireEvent.keyDown(screen.getByTestId('thread-settings-title'), { key: 'Enter' })
    fireEvent.change(screen.getByTestId('thread-settings-priority'), {
      target: { value: 'urgent' },
    })
    fireEvent.click(screen.getByTestId('thread-settings-milestone'))
    fireEvent.click(await screen.findByTestId('thread-settings-milestone-option-milestone'))
    fireEvent.change(screen.getByTestId('thread-settings-tags-input'), {
      target: { value: 'review' },
    })
    fireEvent.keyDown(screen.getByTestId('thread-settings-tags-input'), { key: 'Enter' })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(4))
    expect(update.mock.calls.map(([, input]) => input.version)).toEqual([1, 2, 3, 4])
    expect(
      update.mock.calls.map(([, input]) =>
        Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
      )
    ).toEqual([
      { version: 1, title: 'Renamed' },
      { version: 2, priority: 'urgent' },
      { version: 3, milestoneId: 'milestone' },
      { version: 4, tags: ['review'] },
    ])
    expect(screen.getByTestId('thread-settings-description')).toHaveValue('Draft description')
    await waitFor(() => expect(screen.getByTestId('thread-settings-save')).toBeEnabled())
    fireEvent.click(screen.getByTestId('thread-settings-save'))
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith('G-1', {
        version: 5,
        milestoneId: undefined,
        description: 'Draft description',
      })
    )
    await waitFor(() => expect(screen.getByTestId('thread-settings-save')).toBeDisabled())
  })

  it('retains a failed property draft and retries the same field without saving the description', async () => {
    const { update } = setup()
    update.mockRejectedValueOnce(new Error('Connection lost'))
    fireEvent.change(screen.getByTestId('thread-settings-description'), {
      target: { value: 'Still a draft' },
    })
    fireEvent.change(screen.getByTestId('thread-settings-priority'), {
      target: { value: 'urgent' },
    })
    expect(await screen.findByText('Connection lost')).toBeVisible()
    expect(screen.getByTestId('thread-settings-priority')).toHaveValue('urgent')
    fireEvent.click(screen.getByTestId('thread-settings-retry'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenLastCalledWith('G-1', {
      version: 1,
      priority: 'urgent',
      milestoneId: undefined,
    })
    await waitFor(() =>
      expect(screen.queryByTestId('thread-settings-retry')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('thread-settings-description')).toHaveValue('Still a draft')
  })

  it('does not persist an invalid date range and saves both dates after correction', async () => {
    const { update } = setup()
    fireEvent.change(screen.getByTestId('thread-settings-start'), {
      target: { value: '2026-11-12T17:00' },
    })
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByTestId('thread-settings-due'), {
      target: { value: '2026-11-12T09:00' },
    })
    expect(screen.getByText('截止时间不能早于开始时间')).toBeVisible()
    expect(update).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByTestId('thread-settings-due'), {
      target: { value: '2026-11-12T18:00' },
    })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update.mock.calls[1][1]).toMatchObject({ version: 2, dueAt: expect.any(String) })
    expect(screen.queryByText('截止时间不能早于开始时间')).not.toBeInTheDocument()
  })

  it('does not grant property writes to a read-only group member', async () => {
    const { update } = setup({ role: 'Viewer' })
    expect(screen.getByTestId('thread-settings-priority')).toBeDisabled()
    expect(screen.getByTestId('thread-settings-title')).toBeDisabled()
    fireEvent.change(screen.getByTestId('thread-settings-priority'), {
      target: { value: 'urgent' },
    })
    fireEvent.blur(screen.getByTestId('thread-settings-title'))
    expect(update).not.toHaveBeenCalled()
  })

  it('queues an explicit description save behind an in-flight title save', async () => {
    const { update } = setup()
    let finish!: (value: CollaborationIssue) => void
    update
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            finish = resolve
          })
      )
      .mockResolvedValueOnce({
        ...item,
        title: 'Queued title',
        description: 'Saved description',
        version: 3,
      })
    fireEvent.change(screen.getByTestId('thread-settings-title'), {
      target: { value: 'Queued title' },
    })
    fireEvent.blur(screen.getByTestId('thread-settings-title'))
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByTestId('thread-settings-description'), {
      target: { value: 'Saved description' },
    })
    expect(screen.getByTestId('thread-settings-save')).toBeEnabled()
    fireEvent.click(screen.getByTestId('thread-settings-save'))
    expect(update).toHaveBeenCalledOnce()
    finish({ ...item, title: 'Queued title', version: 2 })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenLastCalledWith('G-1', {
      version: 2,
      milestoneId: undefined,
      description: 'Saved description',
    })
    await waitFor(() => expect(screen.getByTestId('thread-settings-save')).toBeDisabled())
    expect(screen.getByTestId('thread-settings-title')).toHaveValue('Queued title')
    expect(screen.getByTestId('thread-settings-close')).toBeEnabled()
  })

  it.each([
    {
      field: 'title',
      original: 'Review',
      next: 'Renamed',
      response: { title: 'Renamed' },
      patch: { title: 'Review' },
    },
    {
      field: 'priority',
      original: 'none',
      next: 'urgent',
      response: { priority: 'urgent' },
      patch: { priority: 'none' },
    },
    {
      field: 'start',
      original: '',
      next: '2026-11-12T09:00',
      response: { start_at: new Date('2026-11-12T09:00').toISOString() },
      patch: { startAt: null },
    },
  ])(
    'persists a $field return to its original value behind an in-flight change without replacing the latest input',
    async ({ field, original, next, response, patch }) => {
      const { update } = setup()
      let finishFirst!: (value: CollaborationIssue) => void
      let finishSecond!: (value: CollaborationIssue) => void
      update
        .mockImplementationOnce(
          () =>
            new Promise<CollaborationIssue>(resolve => {
              finishFirst = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise<CollaborationIssue>(resolve => {
              finishSecond = resolve
            })
        )
      const input = screen.getByTestId('thread-settings-' + field)
      fireEvent.change(input, { target: { value: next } })
      if (field === 'title') fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(update).toHaveBeenCalledOnce())
      fireEvent.change(input, { target: { value: original } })
      if (field === 'title') fireEvent.keyDown(input, { key: 'Enter' })
      expect(update).toHaveBeenCalledOnce()
      finishFirst({ ...item, ...response, version: 2 } as CollaborationIssue)
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
      expect(update).toHaveBeenNthCalledWith(2, 'G-1', {
        version: 2,
        milestoneId: undefined,
        ...patch,
      })
      expect(input).toHaveValue(original)
      expect(screen.getByTestId('thread-settings-close')).toBeDisabled()
      finishSecond({ ...item, version: 3 })
      await waitFor(() => expect(screen.getByTestId('thread-settings-close')).toBeEnabled())
      expect(input).toHaveValue(original)
    }
  )

  it('allows explicitly saving the original description while an older description save is in flight', async () => {
    const { update } = setup()
    let finishFirst!: (value: CollaborationIssue) => void
    let finishSecond!: (value: CollaborationIssue) => void
    update
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            finishFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            finishSecond = resolve
          })
      )
    const input = screen.getByTestId('thread-settings-description')
    fireEvent.change(input, { target: { value: 'First description' } })
    fireEvent.click(screen.getByTestId('thread-settings-save'))
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByTestId('thread-settings-save')).toBeEnabled()
    fireEvent.click(screen.getByTestId('thread-settings-save'))
    finishFirst({ ...item, description: 'First description', version: 2 })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    expect(update).toHaveBeenNthCalledWith(2, 'G-1', {
      version: 2,
      milestoneId: undefined,
      description: '',
    })
    expect(input).toHaveValue('')
    finishSecond({ ...item, version: 3 })
    await waitFor(() => expect(screen.getByTestId('thread-settings-save')).toBeDisabled())
    expect(input).toHaveValue('')
  })

  it('keeps a milestone clear intent through an earlier unrelated response and an intermediate assignment response', async () => {
    const { update } = setup({ linked: true })
    await screen.findByTestId('thread-settings-milestone')
    let finishPriority!: (value: CollaborationIssue) => void
    let finishAssignment!: (value: CollaborationIssue) => void
    let finishClear!: (value: CollaborationIssue) => void
    update
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            finishPriority = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            finishAssignment = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            finishClear = resolve
          })
      )
    fireEvent.change(screen.getByTestId('thread-settings-priority'), {
      target: { value: 'urgent' },
    })
    await waitFor(() => expect(update).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByTestId('thread-settings-milestone'))
    fireEvent.click(await screen.findByTestId('thread-settings-milestone-option-milestone'))
    fireEvent.click(screen.getByTestId('thread-settings-milestone'))
    fireEvent.click(await screen.findByTestId('thread-settings-milestone-option-empty'))
    finishPriority({ ...item, priority: 'urgent', version: 2 })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    finishAssignment({ ...item, priority: 'urgent', milestone_id: 'milestone', version: 3 })
    await waitFor(() => expect(update).toHaveBeenCalledTimes(3))
    expect(update).toHaveBeenNthCalledWith(3, 'G-1', { version: 3, milestoneId: null })
    expect(screen.getByTestId('thread-settings-milestone')).toHaveAttribute('data-value', '')
    finishClear({ ...item, priority: 'urgent', milestone_id: null, version: 4 })
    await waitFor(() => expect(screen.getByTestId('thread-project-select')).toBeEnabled())
    expect(screen.getByTestId('thread-settings-milestone')).toHaveAttribute('data-value', '')
  })

  it('keeps a failed milestone intent and completes that same draft after retry', async () => {
    const { update } = setup({ linked: true })
    update.mockRejectedValueOnce(new Error('Milestone unavailable'))
    await screen.findByTestId('thread-settings-milestone')
    fireEvent.click(screen.getByTestId('thread-settings-milestone'))
    fireEvent.click(await screen.findByTestId('thread-settings-milestone-option-milestone'))
    expect(await screen.findByText('Milestone unavailable')).toBeVisible()
    expect(screen.getByTestId('thread-settings-milestone')).toHaveAttribute(
      'data-value',
      'milestone'
    )
    expect(screen.getByTestId('thread-project-select')).toBeDisabled()
    fireEvent.click(screen.getByTestId('thread-settings-retry'))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('thread-project-select')).toBeEnabled())
    expect(screen.getByTestId('thread-settings-milestone')).toHaveAttribute(
      'data-value',
      'milestone'
    )
  })

  it.each([false, true])(
    'exposes hierarchy classification only with current project authority (restricted=%s)',
    async restricted => {
      const hierarchy = vi.fn<(context: ThreadSettingsHierarchyContext) => null>(() => null)
      setup({ linked: true, restricted, renderHierarchy: hierarchy })
      await waitFor(() => expect(screen.getByRole('option', { name: 'Plan' })).toBeInTheDocument())
      const context = hierarchy.mock.calls.at(-1)?.[0] as ThreadSettingsHierarchyContext
      expect(context.classificationProject?.id).toBe(restricted ? undefined : 'project')
      expect(context.item.id).toBe(item.id)
    }
  )

  it('provides the accepted current item and the existing unsaved-draft guard to hierarchy actions', async () => {
    const hierarchy = vi.fn<(context: ThreadSettingsHierarchyContext) => null>(() => null)
    setup({ renderHierarchy: hierarchy })
    fireEvent.change(screen.getByTestId('thread-settings-title'), {
      target: { value: 'Hierarchy title' },
    })
    fireEvent.keyDown(screen.getByTestId('thread-settings-title'), { key: 'Enter' })
    await waitFor(() => expect(hierarchy.mock.calls.at(-1)?.[0].item.title).toBe('Hierarchy title'))
    expect(hierarchy.mock.calls.at(-1)?.[0].item.version).toBe(2)
    fireEvent.change(screen.getByTestId('thread-settings-description'), {
      target: { value: 'Unsaved hierarchy draft' },
    })
    const openChild = vi.fn()
    hierarchy.mock.calls.at(-1)?.[0].requestLeave(openChild)
    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(openChild).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('thread-settings-discard'))
    expect(openChild).toHaveBeenCalledOnce()
  })
})
