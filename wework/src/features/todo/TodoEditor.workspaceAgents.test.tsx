import { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'

function setup(store: 'local' | 'backend', mode: 'create' | 'edit' = 'edit') {
  const project = {
    id: 'project',
    workspace_id: 'space',
    name: 'Project',
    project_store: store,
    access_role: 'Owner',
    workspace_access_role: 'Owner',
    current_user_id: 1,
  } as CloudProject
  const item = {
    id: 'ISSUE-1',
    cloud_project_id: 'project',
    title: 'Assign a workspace Agent',
    description: '',
    status: 'inbox',
    priority: 'none',
    parent_id: null,
    due_at: null,
    tags: [],
    version: 1,
    can_edit: true,
    assignee_user_id: null,
  } as CloudLoopItem
  const source = {
    id: 'source',
    name: '空间代码助手',
    status: 'available',
    ...(store === 'local'
      ? {
          location: 'local',
          project_binding_input: {
            name: 'resource-123',
            displayName: '空间代码助手',
            namespace: 'default',
            runtime: 'codex',
            systemPrompt: 'Review the Issue',
            model: 'model-1',
          },
        }
      : { team_id: 42 }),
  }
  const bindings: Record<string, unknown>[] = []
  const api = {
    issues: {
      get: vi.fn(async () => item),
      create: vi.fn(async () => item),
      update: vi.fn(async () => ({ ...item, version: 2 })),
      assign: vi.fn(async () => ({
        ...item,
        version: 3,
        assignee_agent_id: 'project-binding',
        assignee_agent_name: source.name,
      })),
    },
    agents: {
      list: vi.fn(async () => bindings),
      create: vi.fn(async (_id: string, input: Record<string, unknown>) => {
        const created = { ...input, id: 'project-binding', status: 'active' }
        bindings.push(created)
        return created
      }),
    },
    workspaces: {
      list: vi.fn(async () => [{ id: 'space' }]),
      listAgents: vi.fn(async () => [source]),
    },
    members: { list: vi.fn(async () => []) },
    projects: { listCollaborationGroups: vi.fn(async () => []) },
    attachments: {
      list: vi.fn(async () => []),
      upload: vi.fn(async (issueId: string, file: File) => ({
        id: file.name,
        loop_item_id: issueId,
        display_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
        sha256: 'hash',
        created_by_user_id: 1,
        created_at: '2026-10-21T00:00:00Z',
        markdown_url: `wegent://attachments/${file.name}`,
        markdown: '',
      })),
    },
    collaborators: { list: vi.fn(async () => []) },
    taskBindings: { list: vi.fn(async () => []) },
    deliveries: { list: vi.fn(async () => []) },
  }
  const onCreated = vi.fn()
  function Editor() {
    const [current, setCurrent] = useState(item)
    const common = {
      project,
      sharedApi: api as never,
      allItems: [current],
      onClose: vi.fn(),
      currentUserId: 1,
    }
    return mode === 'edit' ? (
      <TodoEditor
        {...common}
        mode="edit"
        item={current}
        onUpdated={setCurrent}
        presentation="workspace-panel"
        readFirst
      />
    ) : (
      <TodoEditor
        {...common}
        mode="create"
        initialParent={null}
        initialStatus="inbox"
        initialTitle={item.title}
        onCreated={onCreated}
      />
    )
  }
  const view = render(<Editor />)
  return {
    api,
    source,
    item,
    onCreated,
    bindings,
    updateProject: (values: Record<string, unknown>) => {
      Object.assign(project, values)
      view.rerender(<Editor />)
    },
  }
}

async function chooseSource(mode: 'create' | 'edit' = 'edit') {
  const user = userEvent.setup()
  await user.click(
    screen.getByTestId(
      mode === 'edit' ? 'cloud-todo-detail-assignee' : 'cloud-todo-create-assignee'
    )
  )
  const option = await screen.findByRole('option', { name: '空间代码助手' })
  await user.click(option)
  return user
}

describe('workspace Agent selection from the Issue assignee picker', () => {
  it.each(['local', 'backend'] as const)(
    'binds and assigns an uninstalled %s Agent from an existing Issue',
    async store => {
      const { api, source } = setup(store)
      const user = await chooseSource()
      expect(api.agents.create).not.toHaveBeenCalled()
      expect(api.issues.assign).not.toHaveBeenCalled()
      expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent(source.name)
      await user.click(screen.getByTestId('cloud-todo-save'))
      await waitFor(() =>
        expect(api.issues.assign).toHaveBeenCalledWith('project', 'ISSUE-1', {
          version: 1,
          assigneeType: 'agent',
          assigneeId: 'project-binding',
        })
      )
      expect(api.agents.create).toHaveBeenCalledExactlyOnceWith(
        'project',
        store === 'local'
          ? source.project_binding_input
          : { name: source.name, runtime: 'wegent', wegentTeamId: 42, shareWithWorkspace: false }
      )
      expect(api.agents.create.mock.invocationCallOrder[0]).toBeLessThan(
        api.issues.assign.mock.invocationCallOrder[0]
      )
      await waitFor(() => expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument())
      await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
      expect(
        await screen.findByTestId('cloud-todo-detail-assignee-option-agent:project-binding')
      ).toHaveTextContent(source.name)
      expect(
        screen.queryByTestId('cloud-todo-detail-assignee-option-resource:source')
      ).not.toBeInTheDocument()
    }
  )

  it.each(['local', 'backend'] as const)(
    'supports direct %s workspace Agent selection during Issue creation',
    async store => {
      const { api, onCreated } = setup(store, 'create')
      const user = await chooseSource('create')
      await user.click(screen.getByTestId('cloud-todo-create-confirm'))
      await waitFor(() => expect(onCreated).toHaveBeenCalled())
      expect(api.agents.create.mock.invocationCallOrder[0]).toBeLessThan(
        api.issues.create.mock.invocationCallOrder[0]
      )
      expect(api.issues.assign).toHaveBeenCalledWith('project', 'ISSUE-1', {
        version: 1,
        assigneeType: 'agent',
        assigneeId: 'project-binding',
      })
    }
  )

  it('keeps the selected assignee after binding failure and never submits a workspace ID as a project Agent', async () => {
    const { api } = setup('backend')
    api.agents.create.mockRejectedValueOnce(new Error('Binding permission denied'))
    const user = await chooseSource()
    await user.click(screen.getByTestId('cloud-todo-save'))
    expect(await screen.findByText('Binding permission denied')).toBeVisible()
    expect(api.issues.assign).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('空间代码助手')
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() => expect(api.issues.assign).toHaveBeenCalledOnce())
  })

  it('reuses the project binding when assignment fails after creation', async () => {
    const { api } = setup('local')
    api.issues.assign.mockRejectedValueOnce(new Error('Assignment unavailable'))
    const user = await chooseSource()
    await user.click(screen.getByTestId('cloud-todo-save'))
    expect(await screen.findByText('Assignment unavailable')).toBeVisible()
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() => expect(api.issues.assign).toHaveBeenCalledTimes(2))
    expect(api.agents.create).toHaveBeenCalledOnce()
  })

  it('does not create an Issue if its selected workspace Agent cannot be enabled', async () => {
    const { api } = setup('backend', 'create')
    api.agents.create.mockRejectedValueOnce(new Error('Resource grant revoked'))
    const user = await chooseSource('create')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    expect(await screen.findByText('Resource grant revoked')).toBeVisible()
    expect(api.issues.create).not.toHaveBeenCalled()
    expect(api.issues.assign).not.toHaveBeenCalled()
  })

  it.each(['local', 'backend'] as const)(
    'resumes the same new %s Issue and binding after assignment failure',
    async store => {
      const { api, onCreated } = setup(store, 'create')
      api.issues.assign.mockRejectedValueOnce(new Error('Assignment cancelled'))
      const user = await chooseSource('create')
      await user.click(screen.getByTestId('cloud-todo-create-confirm'))
      expect(await screen.findByText('Assignment cancelled')).toBeVisible()
      expect(onCreated).not.toHaveBeenCalled()
      await user.click(screen.getByTestId('cloud-todo-create-confirm'))
      await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
      expect(api.issues.create).toHaveBeenCalledOnce()
      expect(api.agents.create).toHaveBeenCalledOnce()
      expect(api.issues.get).toHaveBeenCalledWith('ISSUE-1')
      expect(api.issues.assign).toHaveBeenCalledTimes(2)
      expect(api.issues.assign.mock.calls.every(([, issueId]) => issueId === 'ISSUE-1')).toBe(true)
    }
  )

  it('reads a committed assignment before resuming and preserves user edits without duplicate execution', async () => {
    const { api, onCreated } = setup('local', 'create')
    api.issues.assign.mockRejectedValueOnce(new Error('Assignment response lost'))
    const user = await chooseSource('create')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    expect(await screen.findByText('Assignment response lost')).toBeVisible()
    const committed = {
      ...(await api.issues.create.mock.results[0].value),
      status: 'in_progress',
      assignee_agent_id: 'project-binding',
      version: 3,
    }
    api.issues.get.mockResolvedValue(committed)
    api.issues.update.mockResolvedValue({ ...committed, title: 'Updated draft', version: 4 })
    await user.clear(screen.getByTestId('cloud-todo-title'))
    await user.type(screen.getByTestId('cloud-todo-title'), 'Updated draft')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(api.issues.create).toHaveBeenCalledOnce()
    expect(api.issues.assign).toHaveBeenCalledOnce()
    expect(api.issues.update).toHaveBeenCalledExactlyOnceWith('ISSUE-1', {
      version: 3,
      title: 'Updated draft',
    })
    expect(onCreated.mock.calls[0][0]).toMatchObject({
      id: 'ISSUE-1',
      title: 'Updated draft',
      status: 'in_progress',
      assignee_agent_id: 'project-binding',
    })
  })

  it('clears a committed assignee removed from the failed create draft', async () => {
    const { api, item, onCreated } = setup('local', 'create')
    api.issues.assign.mockRejectedValueOnce(new Error('Assignment response lost'))
    const user = await chooseSource('create')
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    expect(await screen.findByText('Assignment response lost')).toBeVisible()
    api.issues.get.mockResolvedValue({ ...item, assignee_agent_id: 'project-binding', version: 3 })
    await user.click(screen.getByTestId('cloud-todo-create-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-create-assignee-option-empty'))
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(api.issues.create).toHaveBeenCalledOnce()
    expect(api.issues.assign).toHaveBeenCalledOnce()
    expect(api.issues.update).toHaveBeenCalledExactlyOnceWith('ISSUE-1', {
      version: 3,
      assigneeUserId: null,
      assigneeAgentId: null,
      assigneeTeamId: null,
    })
  })

  it('preserves creation automation when the draft never selected an assignee', async () => {
    const { api, item, onCreated } = setup('backend', 'create')
    api.issues.create.mockResolvedValue({ ...item, assignee_agent_id: 'automation-agent' })
    await userEvent.setup().click(screen.getByTestId('cloud-todo-create-confirm'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(api.issues.assign).not.toHaveBeenCalled()
    expect(api.issues.update).not.toHaveBeenCalled()
    expect(onCreated.mock.calls[0][0].assignee_agent_id).toBe('automation-agent')
  })

  it('reuses completed and still-running uploads while retrying only the failed file', async () => {
    const { api, onCreated } = setup('local', 'create')
    const files = ['first.txt', 'failed.txt', 'late.txt'].map(
      name => new File([name], name, { type: 'text/plain' })
    )
    const upload = api.attachments.upload.getMockImplementation()!
    let releaseLate!: () => void
    const late = new Promise<void>(resolve => {
      releaseLate = resolve
    })
    let fail = true
    api.attachments.upload.mockImplementation(async (issueId, file) => {
      if (file.name === 'failed.txt' && fail) {
        fail = false
        throw new Error('One upload failed')
      }
      if (file.name === 'late.txt') await late
      return upload(issueId, file)
    })
    const user = await chooseSource('create')
    await user.upload(screen.getByTestId('cloud-todo-attachment-input'), files)
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    expect(await screen.findByText('One upload failed')).toBeVisible()
    api.issues.get.mockResolvedValue(await api.issues.assign.mock.results[0].value)
    await user.click(screen.getByTestId('cloud-todo-create-confirm'))
    await waitFor(() => expect(api.attachments.upload).toHaveBeenCalledTimes(4))
    expect(onCreated).not.toHaveBeenCalled()
    expect(api.attachments.upload.mock.calls.map(([, file]) => file.name)).toEqual([
      'first.txt',
      'failed.txt',
      'late.txt',
      'failed.txt',
    ])
    await act(async () => releaseLate())
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce())
    expect(api.issues.create).toHaveBeenCalledOnce()
    expect(api.issues.assign).toHaveBeenCalledOnce()
    expect(api.agents.create).toHaveBeenCalledOnce()
  })

  it('retains installed assignees when the workspace catalog cannot be loaded', async () => {
    const { api, bindings } = setup('backend')
    bindings.push({ id: 'installed', name: '已加入项目的智能体', status: 'active' })
    api.workspaces.listAgents.mockRejectedValue(new Error('Catalog unavailable'))
    await userEvent.setup().click(screen.getByTestId('cloud-todo-detail-assignee'))
    expect(await screen.findByRole('option', { name: '已加入项目的智能体' })).toBeVisible()
    expect(api.agents.create).not.toHaveBeenCalled()
  })

  it('clears workspace options immediately when verified legacy access becomes an explicit project-only guest', async () => {
    const { api, updateProject } = setup('backend')
    updateProject({ workspace_access_role: undefined })
    await userEvent.setup().click(screen.getByTestId('cloud-todo-detail-assignee'))
    expect(await screen.findByRole('option', { name: '空间代码助手' })).toBeVisible()
    expect(api.workspaces.list).toHaveBeenCalled()
    updateProject({ workspace_access_role: null })
    expect(screen.queryByRole('option', { name: '空间代码助手' })).not.toBeInTheDocument()
  })
})
