import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi, ThreadParticipation } from '@/api/chatGroups'
import { ThreadSettings } from './ThreadSettings'
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
    restricted?: boolean
    saveError?: Error
    linkError?: Error
    localPrincipal?: boolean
  } = {}
) {
  const project = { ...groupBoardContext(group, 'cloud'), id: 'project', name: 'Plan' }
  const update = options.saveError
    ? vi.fn().mockRejectedValue(options.saveError)
    : vi.fn().mockImplementation(async (_id, input) => ({ ...item, ...input, version: 2 }))
  const issues = {
    get: vi
      .fn()
      .mockResolvedValue(
        options.saveError ? { ...item, title: 'Other user title', version: 2 } : item
      ),
    update,
  }
  const api = { issues } as unknown as SharedWorkspaceApi
  const milestoneList = vi
    .fn()
    .mockResolvedValue([{ id: 'milestone', title: 'Release', project_id: 'project' }])
  const catalog = {
    projects: { list: vi.fn().mockResolvedValue([project]) },
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
      group={group}
      project={groupBoardContext(group, 'cloud')}
      item={item}
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
    expect(await screen.findByRole('option', { name: 'Release' })).toBeInTheDocument()
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
    fireEvent.click(screen.getByTestId('thread-settings-save'))
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
    fireEvent.click(screen.getByTestId('thread-settings-save'))
    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(await screen.findByText('Thread changed')).toBeVisible()
    expect(screen.getByTestId('thread-settings-title')).toHaveValue('My new title')
    expect(onChanged).not.toHaveBeenCalled()
  })
})
