import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import * as desktopHost from '@/api/dsh/desktopHost'
import '@/i18n'
import * as runtimeEnvironment from '@/lib/runtime-environment'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
  it('keeps the selected assignee after binding failure and never submits a workspace ID as a project Agent', async () => {
    const { api } = setup('backend')
    api.agents.create.mockRejectedValueOnce(new Error('Binding permission denied'))
    const user = await chooseSource()
    expect(await screen.findByText('Binding permission denied')).toBeVisible()
    expect(api.issues.assign).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('空间代码助手')
    await user.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(api.issues.assign).toHaveBeenCalledOnce())
  })

  it('reuses the project binding when assignment fails after creation', async () => {
    const { api } = setup('local')
    api.issues.assign.mockRejectedValueOnce(new Error('Assignment unavailable'))
    const user = await chooseSource()
    expect(await screen.findByText('Assignment unavailable')).toBeVisible()
    await user.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(api.issues.assign).toHaveBeenCalledTimes(2))
    expect(api.agents.create).toHaveBeenCalledOnce()
  })

  it('shows the persisted project Agent after retrying a workspace resource assignment', async () => {
    const { api } = setup('local')
    api.issues.assign.mockRejectedValueOnce(new Error('Assignment unavailable'))
    const user = await chooseSource()
    expect(await screen.findByText('Assignment unavailable')).toBeVisible()
    await user.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute(
        'data-value',
        'agent:project-binding'
      )
    )
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('空间代码助手')
    expect(api.agents.create).toHaveBeenCalledOnce()
  })

  it('preserves a newer assignee selection while the resource assignment completes', async () => {
    const { api, item } = setup('local')
    const pending = Promise.withResolvers<CloudLoopItem>()
    api.issues.assign.mockImplementationOnce(() => pending.promise)
    const user = await chooseSource()
    await waitFor(() => expect(api.issues.assign).toHaveBeenCalledOnce())
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-empty'))
    await act(async () =>
      pending.resolve({ ...item, assignee_agent_id: 'project-binding', version: 2 })
    )
    await waitFor(() =>
      expect(api.issues.update).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ version: 2, assigneeAgentId: null })
      )
    )
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toHaveAttribute('data-value', '')
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

  it('previews a staged image while creating an Issue', async () => {
    const user = userEvent.setup()
    const image = new File(['image'], 'image.png', { type: 'image/png' })
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:staged-issue-image-preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    setup('backend', 'create')

    await user.upload(screen.getByTestId('cloud-todo-attachment-input'), image)

    expect(await screen.findByText('image.png')).toBeInTheDocument()
    const thumbnail = await screen.findByTestId('issue-detail-attachment-thumbnail-pending-0')
    expect(thumbnail).toHaveAttribute('src', 'blob:staged-issue-image-preview')
    expect(createObjectUrl).toHaveBeenCalledWith(image)
    fireEvent.error(thumbnail)
    expect(thumbnail).not.toBeInTheDocument()
    const row = screen.getByText('image.png').closest('.shared-issue-detail-attachment-row')
    expect(row?.querySelector('.issue-detail-attachment-fallback')).not.toBeNull()
  })

  it('converts a TIFF from clipboard history before previewing a staged image', async () => {
    const screenshot = new File(['tiff'], '2026-11-12_14-07-58.tiff', {
      type: 'image/tiff',
    })
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:normalized-issue-image-preview')
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const electronRuntime = vi.spyOn(runtimeEnvironment, 'isElectronRuntime').mockReturnValue(true)
    const convertClipboardImage = vi
      .spyOn(desktopHost, 'invokeDesktopHost')
      .mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')

    try {
      setup('backend', 'create')
      fireEvent.paste(screen.getByTestId('cloud-todo-detail-description'), {
        clipboardData: { files: [screenshot] },
      })

      expect(await screen.findByText('2026-11-12_14-07-58.png')).toBeInTheDocument()
      const normalized = await waitFor(() => {
        const file = createObjectUrl.mock.calls
          .map(([candidate]) => candidate as File)
          .find(candidate => candidate.name === '2026-11-12_14-07-58.png')
        expect(file).toBeDefined()
        return file!
      })
      expect(normalized).toMatchObject({
        name: '2026-11-12_14-07-58.png',
        type: 'image/png',
      })
      expect(convertClipboardImage).toHaveBeenCalledWith('clipboard.convertImageToPng', {
        dataBase64: 'dGlmZg==',
        fileName: '2026-11-12_14-07-58.tiff',
        mimeType: 'image/tiff',
      })
    } finally {
      createObjectUrl.mockRestore()
      revokeObjectUrl.mockRestore()
      electronRuntime.mockRestore()
      convertClipboardImage.mockRestore()
    }
  })

  it('keeps a staged document identity after removing an earlier image', async () => {
    const user = userEvent.setup()
    const image = new File(['image'], 'a.png', { type: 'image/png' })
    const document = new File(['document'], 'b.txt', { type: 'text/plain' })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:staged-issue-image-preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    setup('backend', 'create')

    await user.upload(screen.getByTestId('cloud-todo-attachment-input'), [image, document])

    await screen.findByText('a.png')
    expect(
      await screen.findByTestId('issue-detail-attachment-thumbnail-pending-0')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '删除 a.png' }))

    await waitFor(() => expect(screen.queryByText('a.png')).not.toBeInTheDocument())
    const documentRow = screen.getByText('b.txt').closest('button')?.parentElement
    expect(documentRow).not.toBeNull()
    expect(documentRow?.querySelector('.issue-detail-attachment-fallback')).not.toBeNull()
    expect(
      within(documentRow as HTMLElement).queryByTestId(/^issue-detail-attachment-thumbnail-/)
    ).not.toBeInTheDocument()
  })

  it('retains installed assignees when the workspace catalog cannot be loaded', async () => {
    const { api, bindings } = setup('backend')
    bindings.push({ id: 'installed', name: '已加入项目的智能体', status: 'active' })
    api.workspaces.listAgents.mockRejectedValue(new Error('Catalog unavailable'))
    await userEvent.setup().click(screen.getByTestId('cloud-todo-detail-assignee'))
    expect(await screen.findByRole('option', { name: '已加入项目的智能体' })).toBeVisible()
    expect(api.agents.create).not.toHaveBeenCalled()
  })
})
