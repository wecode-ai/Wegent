import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import {
  collaborationMessages,
  type CollaborationIssue,
  type IssueCreateProps,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { ThreadCreateDialog } from './ThreadCreateDialog'
import { groupBoardContext } from './groupWorkspaceApi'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
})

const group: ChatGroup = {
  id: 'group-1',
  name: '产品群',
  project_key: 'G',
  description: '',
  status: 'active',
  role: 'Owner',
  version: 1,
  created_by_user_id: 7,
  created_at: '2026-11-11T00:00:00Z',
  updated_at: '2026-11-11T00:00:00Z',
}
const project = { ...groupBoardContext(group, 'cloud'), id: 'project-1', name: '体验项目' }

function setup(
  entries: ChatGroup[] = [group],
  parent?: CollaborationIssue,
  accountScope = 'fixture:user-7',
  provider = 'local'
) {
  const create = vi.fn(async (id: string, input: { title: string; status?: string }) => ({
    id: 'G-1',
    cloud_project_id: id,
    group_id: id,
    group_name: group.name,
    sequence_number: 1,
    title: input.title,
    description: '',
    status: input.status ?? 'inbox',
    priority: 'none',
    parent_id: null,
    assignee_user_id: null,
    created_by_user_id: 7,
    tags: [],
    due_at: null,
    sort_order: 0,
    version: 1,
    current_delivery_id: null,
    completed_at: null,
    created_at: group.created_at,
    updated_at: group.updated_at,
  }))
  const projectRoster = vi.fn(async () => [
    { id: 99, user_id: 99, user_name: '仅项目成员', role: 'Developer' },
  ])
  const api = {
    projects: { list: vi.fn(async () => [project]), get: vi.fn(async () => project) },
    issues: { create, list: vi.fn(async () => []) },
    members: { list: projectRoster },
    agents: { list: vi.fn(async () => []) },
    attachments: {
      list: vi.fn(async () => []),
      upload: vi.fn(),
      read: vi.fn(),
      remove: vi.fn(),
    },
    collaborators: {
      list: vi.fn(async () => []),
      add: vi.fn(),
      remove: vi.fn(),
    },
    deliveries: { list: vi.fn(async () => []), get: vi.fn() },
  } as unknown as SharedWorkspaceApi
  const groups = {
    list: vi.fn(async () => ({ items: entries })),
    get: vi.fn(async () => ({ group, members: [{ user_id: 7, name: '我', role: 'Owner' }] })),
    create: vi.fn(async () => ({ group })),
  } as unknown as ChatGroupApi
  const created = vi.fn()
  const form: IssueCreateProps = {
    api,
    project: { ...project, task_provider: provider, access_role: 'Owner' },
    allIssues: parent && provider !== 'local' ? [parent] : [],
    messages: collaborationMessages['zh-CN'],
    onClose: vi.fn(),
    onCreated: created,
    onError: vi.fn(),
    ...(parent ? { defaults: { status: 'pending', tags: [], draftScope: 'parent', parent } } : {}),
  }
  const view = render(
    <ThreadCreateDialog
      form={form}
      externalForm={provider === 'local' ? undefined : form}
      api={api}
      groups={groups}
      store="cloud"
      locale="zh-CN"
      accountScope={accountScope}
    />
  )
  return { ...view, api, groups, form, create, created, projectRoster }
}

describe('project-origin Thread creation', () => {
  it('blocks switching sources while the original creation is pending', async () => {
    const { create, groups, form } = setup([group], undefined, 'external:pending', 'github')
    let rejectRequest!: (error: Error) => void
    create.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject
        })
    )
    fireEvent.change(await screen.findByTestId('cloud-todo-title'), {
      target: { value: 'pending source request' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-create-confirm'))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const switchSource = screen.getByTestId('external-create-group-thread')
    expect(switchSource).toBeDisabled()
    fireEvent.click(switchSource)
    expect(groups.list).not.toHaveBeenCalled()
    rejectRequest(new Error('source failed'))
    await waitFor(() => expect(form.onError).toHaveBeenCalled())
    expect(switchSource).toBeEnabled()
    fireEvent.click(switchSource)
    await screen.findByTestId('thread-create-group-dialog')
  })

  it.each(['github', 'gitlab', 'dingtalk_aitable'])(
    'preserves the %s parent and prevents conversion to a group child',
    async provider => {
      const parent = {
        id: `${provider}-parent`,
        cloud_project_id: project.id,
        title: '外部上级',
        status: 'pending',
        tags: [],
      } as unknown as CollaborationIssue
      const { create, groups } = setup([group], parent, `external-parent:${provider}`, provider)
      expect(screen.queryByTestId('external-create-group-thread')).not.toBeInTheDocument()
      fireEvent.change(await screen.findByTestId('cloud-todo-title'), {
        target: { value: '外部子事项' },
      })
      fireEvent.click(screen.getByTestId('cloud-todo-create-confirm'))
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith(
          project.id,
          expect.objectContaining({ parentId: parent.id })
        )
      )
      expect(groups.list).not.toHaveBeenCalled()
    }
  )

  it.each(['github', 'gitlab', 'dingtalk_aitable'])(
    'keeps %s creation on its original source and retains failed drafts',
    async provider => {
      const { create, groups, form } = setup([group], undefined, `external:${provider}`, provider)
      const title = await screen.findByTestId('cloud-todo-title')
      fireEvent.change(title, { target: { value: `source record ${provider}` } })
      create.mockRejectedValueOnce(new Error('source unavailable'))
      fireEvent.click(screen.getByTestId('cloud-todo-create-confirm'))
      await waitFor(() => expect(form.onError).toHaveBeenCalled())
      expect(title).toHaveValue(`source record ${provider}`)
      expect(create).toHaveBeenCalledWith(
        project.id,
        expect.not.objectContaining({ classificationProjectId: expect.anything() })
      )
      expect(groups.list).not.toHaveBeenCalled()
      expect(groups.create).not.toHaveBeenCalled()
      fireEvent.click(screen.getByTestId('external-create-group-thread'))
      await screen.findByTestId('thread-create-group-dialog')
      fireEvent.click(screen.getByTestId('thread-create-group-cancel'))
      expect(screen.getByTestId('cloud-todo-title')).toHaveValue(`source record ${provider}`)
      expect(screen.queryByTestId('thread-create-group-dialog')).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId('cloud-todo-create-confirm'))
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
      expect(groups.create).not.toHaveBeenCalled()
    }
  )

  it('only creates a group Thread after an explicit source switch', async () => {
    const { create } = setup([group], undefined, 'external:explicit-switch', 'github')
    fireEvent.change(await screen.findByTestId('cloud-todo-title'), {
      target: { value: 'private external draft' },
    })
    fireEvent.click(screen.getByTestId('external-create-group-thread'))
    await screen.findByRole('option', { name: group.name })
    fireEvent.change(screen.getByTestId('thread-create-group-select'), {
      target: { value: group.id },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    await screen.findByTestId('thread-create-context')
    const editors = screen.getAllByTestId('cloud-todo-title')
    expect(editors[1]).toHaveValue('')
    fireEvent.change(editors[1]!, { target: { value: 'explicit group Thread' } })
    fireEvent.click(screen.getAllByTestId('cloud-todo-create-confirm')[1]!)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(
      group.id,
      expect.objectContaining({
        title: 'explicit group Thread',
        classificationProjectId: project.id,
      })
    )
  })

  it('retains a private draft for its account without exposing it to another group member', async () => {
    const first = setup([group], undefined, 'fixture:private-user-7')
    await screen.findByRole('option', { name: group.name })
    fireEvent.change(screen.getByTestId('thread-create-group-select'), {
      target: { value: group.id },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    fireEvent.change(await screen.findByTestId('cloud-todo-title'), {
      target: { value: '尚未发送的私有草稿' },
    })
    await waitFor(() =>
      expect(
        Object.keys(localStorage).some(
          key =>
            key.includes('fixture:private-user-7') &&
            localStorage.getItem(key)?.includes('尚未发送的私有草稿')
        )
      ).toBe(true)
    )
    first.unmount()
    const second = setup([group], undefined, 'fixture:private-user-8')
    await screen.findByRole('option', { name: group.name })
    fireEvent.change(screen.getByTestId('thread-create-group-select'), {
      target: { value: group.id },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    expect(await screen.findByTestId('cloud-todo-title')).toHaveValue('')
    second.unmount()
    setup([group], undefined, 'fixture:private-user-7')
    await screen.findByRole('option', { name: group.name })
    fireEvent.change(screen.getByTestId('thread-create-group-select'), {
      target: { value: group.id },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    expect(await screen.findByTestId('cloud-todo-title')).toHaveValue('尚未发送的私有草稿')
  })
  it('uses the selected group for the full editor and creates its project link atomically', async () => {
    const { api, create, created, projectRoster } = setup()
    await screen.findByRole('option', { name: group.name })
    fireEvent.change(screen.getByTestId('thread-create-group-select'), {
      target: { value: group.id },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    expect(await screen.findByTestId('thread-create-context')).toHaveTextContent(
      '所属群：产品群 · 关联项目：体验项目'
    )
    expect(api.issues.list).toHaveBeenCalledWith(group.id)
    expect(projectRoster).not.toHaveBeenCalled()
    fireEvent.change(screen.getByTestId('cloud-todo-title'), {
      target: { value: '从项目创建的 Thread' },
    })
    fireEvent.click(screen.getByTestId('cloud-todo-create-confirm'))
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        group.id,
        expect.objectContaining({
          title: '从项目创建的 Thread',
          classificationProjectId: project.id,
        })
      )
    )
    await waitFor(() =>
      expect(created).toHaveBeenCalledWith(expect.objectContaining({ group_id: group.id }))
    )
  })

  it('creates an explicitly named group without copying the project roster', async () => {
    const { groups, projectRoster } = setup([])
    const name = await screen.findByTestId('thread-create-new-group-name')
    fireEvent.change(name, { target: { value: '独立评审群' } })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    await screen.findByTestId('thread-create-context')
    expect(groups.create).toHaveBeenCalledExactlyOnceWith({ name: '独立评审群' })
    expect(projectRoster).not.toHaveBeenCalled()
  })

  it('does not create a different group when the parent group is no longer writable', async () => {
    const parent = {
      id: 'G-parent',
      group_id: group.id,
      cloud_project_id: group.id,
    } as CollaborationIssue
    const { groups, create } = setup([{ ...group, role: 'Viewer' }], parent)
    expect(await screen.findByRole('alert')).toHaveTextContent('当前群为只读')
    expect(screen.getByTestId('thread-create-group-next')).toBeDisabled()
    expect(screen.queryByTestId('thread-create-new-group-name')).not.toBeInTheDocument()
    expect(groups.create).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('reuses the created group after its initial load fails', async () => {
    const { groups } = setup([])
    vi.mocked(groups.get).mockRejectedValueOnce(new Error('加载失败'))
    fireEvent.change(await screen.findByTestId('thread-create-new-group-name'), {
      target: { value: '不重复创建的群' },
    })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    expect(await screen.findByRole('alert')).toHaveTextContent('加载失败')
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    await screen.findByTestId('thread-create-context')
    expect(groups.create).toHaveBeenCalledTimes(1)
    expect(vi.mocked(groups.get).mock.calls.every(([id]) => id === group.id)).toBe(true)
  })

  it('rejects a missing parent rather than silently creating a top-level Thread', async () => {
    const parent = { id: 'G-missing', group_id: group.id } as CollaborationIssue
    const { create } = setup([group], parent)
    await screen.findByRole('option', { name: group.name })
    fireEvent.click(screen.getByTestId('thread-create-group-next'))
    expect(await screen.findByRole('alert')).toHaveTextContent('父事项已不可用')
    expect(screen.queryByTestId('cloud-todo-title')).not.toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })
})
