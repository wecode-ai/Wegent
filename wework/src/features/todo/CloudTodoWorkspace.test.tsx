import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { User } from '@/types/api'
import { CloudTodoWorkspace } from './CloudTodoWorkspace'

const project = {
  id: 11,
  public_id: 'cloud-public-id',
  project_key: 'WEG',
  name: 'Wegent V4',
  description: 'Shared project',
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
}

const item = {
  id: 'WEG-1',
  cloud_project_id: 11,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: null,
  title: 'Implement cloud MCP',
  description: 'Use the shared workspace',
  status: 'in_progress' as const,
  priority: 'high' as const,
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  completed_at: null,
}

function services(): WorkbenchServices {
  return {
    deliveryApi: {
      listCloudProjects: vi.fn(async () => ({ items: [project] })),
      createCloudProject: vi.fn(async values => ({
        ...project,
        id: 12,
        project_key: values.project_key ?? 'AUTO123',
        name: values.name,
        description: values.description ?? '',
      })),
      updateLoopItem: vi.fn(async (_itemId, values) => ({
        ...item,
        ...values,
        version: item.version + 1,
      })),
      listLoopItems: vi.fn(async () => ({ items: [item] })),
      listDeliveries: vi.fn(async () => ({ items: [] })),
      listLoopItemAttachments: vi.fn(async () => []),
      addLoopItemAttachment: vi.fn(async (_itemId, file) => ({
        id: 'attachment-1',
        loop_item_id: item.id,
        display_name: file.name,
        content_type: file.type,
        size_bytes: file.size,
        sha256: 'hash',
        created_by_user_id: 1,
        created_at: '2026-07-22T00:00:00Z',
      })),
      accessLoopItemAttachment: vi.fn(async () => ({
        url: 'https://storage.test/attachment-1',
        expires_in_seconds: 900,
      })),
      deleteLoopItemAttachment: vi.fn(async () => undefined),
      listTaskBindings: vi.fn(async () => [
        {
          id: 1,
          loop_item_id: item.id,
          task_user_id: 1,
          device_id: 'local-device',
          task_id: 'runtime-248868498',
          task_title: 'Implement cloud delivery',
          backend_task_id: null,
          linked_at: '2026-07-22T00:00:00Z',
        },
      ]),
      listLoopItemCollaborators: vi.fn(async () => [
        {
          id: 1,
          loop_item_id: item.id,
          user_id: 1,
          user_name: 'local',
          email: 'local@example.com',
          source: 'task',
          added_by_user_id: 1,
          created_at: '2026-07-22T00:00:00Z',
        },
      ]),
      addLoopItemCollaborator: vi.fn(async (_itemId, userId) => ({
        id: 2,
        loop_item_id: item.id,
        user_id: userId,
        user_name: 'alice',
        email: 'alice@example.com',
        source: 'manual',
        added_by_user_id: 1,
        created_at: '2026-07-23T00:00:00Z',
      })),
      removeLoopItemCollaborator: vi.fn(async () => undefined),
      listMyWork: vi.fn(async () => ({ items: [] })),
      listCloudProjectMembers: vi.fn(async () => [
        {
          id: 1,
          user_id: 1,
          user_name: 'local',
          email: 'local@example.com',
          role: 'Owner',
        },
        {
          id: 2,
          user_id: 2,
          user_name: 'alice',
          email: 'alice@example.com',
          role: 'Developer',
        },
      ]),
      searchCloudProjectUsers: vi.fn(async () => ({ users: [], total: 0 })),
      listCloudFiles: vi.fn(async () => ({ items: [] })),
      listProjectDeliveryFiles: vi.fn(async () => ({ items: [] })),
      createCloudFolder: vi.fn(async (_projectId: number, path: string) => ({
        id: 51,
        cloud_project_id: 11,
        path,
        name: path,
        kind: 'folder',
        content_type: null,
        size_bytes: 0,
        sha256: null,
        description: '',
        created_by_user_id: 1,
        updated_by_user_id: 1,
        version: 1,
        created_at: '2026-07-22T00:00:00Z',
        updated_at: '2026-07-22T00:00:00Z',
      })),
    },
  } as unknown as WorkbenchServices
}

describe('CloudTodoWorkspace', () => {
  it('shows only one hierarchy level at a time on the board', async () => {
    const workbenchServices = services()
    const child = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      parent_id: item.id,
      title: 'Frontend',
    }
    const grandchild = {
      ...item,
      id: 'WEG-3',
      sequence_number: 3,
      parent_id: child.id,
      title: 'Login page',
    }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [item, child, grandchild],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-board-view'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-2')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-open-children-WEG-1'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-2')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-card-WEG-3')).not.toBeInTheDocument()
    expect(
      screen.getByTestId('cloud-project-header').querySelector('[data-tauri-drag-region]')
    ).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('cloud-todo-open-children-WEG-2'))
    expect(await screen.findByTestId('cloud-todo-card-WEG-3')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '顶层任务' }))
    expect(await screen.findByTestId('cloud-todo-card-WEG-1')).toBeInTheDocument()
  })

  it('creates a child directly from a board card', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: values.title,
      parent_id: values.parent_id ?? null,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-board-view'))
    await userEvent.click(await screen.findByTestId('cloud-todo-card-add-child-WEG-1'))
    expect(screen.getByTestId('cloud-todo-create-parent')).toHaveValue('WEG-1')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Frontend')
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Frontend',
        description: '',
        priority: 'none',
        status: 'inbox',
        parent_id: 'WEG-1',
      })
    )
  })

  it('associates an existing task with a parent from the edit dialog', async () => {
    const workbenchServices = services()
    const parent = {
      ...item,
      id: 'WEG-2',
      sequence_number: 2,
      title: 'Release',
      parent_id: null,
    }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item, parent] }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-detail-parent'), 'WEG-2')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        title: item.title,
        description: item.description,
        priority: item.priority,
        status: item.status,
        parent_id: 'WEG-2',
        assignee_user_id: null,
        due_at: null,
      })
    )
  })

  it('uses cloud projects as the primary navigation and opens a TODO detail', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    expect(screen.getByTestId('cloud-todo-workspace')).toHaveClass('absolute', 'inset-0', 'w-full')
    expect(screen.getByTestId('cloud-todo-app-current')).toHaveTextContent('看板')
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toBeInTheDocument()
    expect(screen.getAllByTestId('macos-titlebar-drag-region')).toHaveLength(2)
    expect((await screen.findAllByText('项目空间')).length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByText('Wegent V4').length).toBeGreaterThan(0))
    await userEvent.click(screen.getAllByText('Wegent V4')[0])
    const projectHeader = screen.getByTestId('cloud-project-header')
    expect(projectHeader).toHaveClass('h-[38px]', 'shrink-0')
    expect(projectHeader.querySelector('[data-tauri-drag-region]')).toBeInTheDocument()
    expect(screen.getAllByTestId('macos-titlebar-drag-region')).toHaveLength(2)
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(await screen.findByText('任务详情')).toBeInTheDocument()
    expect(screen.getAllByText('Implement cloud MCP').length).toBeGreaterThan(0)
    expect(screen.getByText('Implement cloud delivery')).toBeInTheDocument()
    expect(screen.getAllByText('local').length).toBeGreaterThan(0)
    expect(screen.getByText('自动加入')).toBeInTheDocument()
  })

  it('manually adds a project member as a TODO collaborator', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect((await screen.findAllByText(/参与者/)).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByTestId('cloud-todo-add-collaborator'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-collaborator-select'), '2')
    await userEvent.click(screen.getByTestId('cloud-todo-confirm-collaborator'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.addLoopItemCollaborator).toHaveBeenCalledWith(
        'WEG-1',
        2
      )
    )
    expect((await screen.findAllByText('alice')).length).toBeGreaterThan(0)
  })

  it('creates a child from the task detail', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    await userEvent.click(await screen.findByTestId('cloud-todo-detail-add-child'))

    expect(screen.getByTestId('cloud-todo-create-parent')).toHaveValue('WEG-1')
    expect(screen.getAllByText('新建子任务').length).toBeGreaterThan(0)
  })

  it('adds an attachment from the TODO edit dialog', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const file = new File(['context'], 'brief.txt', { type: 'text/plain' })
    await userEvent.upload(screen.getByTestId('cloud-todo-attachment-input'), file)

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.addLoopItemAttachment).toHaveBeenCalledWith(
        'WEG-1',
        file
      )
    )
    expect((await screen.findAllByText('brief.txt')).length).toBeGreaterThan(0)
  })

  it('collapses and restores the sidebar chrome', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click(screen.getByTestId('cloud-todo-collapse-sidebar'))
    expect(screen.getByTestId('cloud-todo-collapsed-app-current')).toHaveTextContent('看板')

    await userEvent.click(screen.getByTestId('cloud-todo-expand-sidebar'))
    expect(screen.queryByTestId('cloud-todo-collapsed-chrome-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('cloud-todo-sidebar-chrome-controls')).toBeInTheDocument()
  })

  it('opens the cloud project creation flow', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )
    await waitFor(() => expect(screen.getByTestId('cloud-project-add')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-name')).toBeInTheDocument()
    expect(screen.getByText('项目标识将在创建时自动生成。')).toBeInTheDocument()
    expect(screen.queryByTestId('cloud-project-key')).not.toBeInTheDocument()
  })

  it('creates a project space without requesting a project key', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    await userEvent.type(screen.getByTestId('cloud-project-name'), 'Wegent Test')
    await userEvent.click(screen.getByTestId('cloud-project-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudProject).toHaveBeenCalledWith({
        name: 'Wegent Test',
        description: '',
      })
    )
    expect(screen.queryByTestId('cloud-project-name')).not.toBeInTheDocument()
  })

  it('requires only a project-space name before creating', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click(await screen.findByTestId('cloud-project-add'))
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeDisabled()
    await userEvent.type(screen.getByTestId('cloud-project-name'), '中文项目空间')
    expect(screen.getByTestId('cloud-project-create-confirm')).toBeEnabled()
    expect(workbenchServices.deliveryApi?.createCloudProject).not.toHaveBeenCalled()
  })

  it('opens project member management and filters the board', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-project-settings'))
    expect(await screen.findByTestId('cloud-project-member-1')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-modal-close'))

    await userEvent.click(screen.getByTestId('cloud-search-toggle'))
    await userEvent.type(screen.getByTestId('cloud-search-input'), 'missing')
    expect(screen.queryByTestId('cloud-todo-card-WEG-1')).not.toBeInTheDocument()
  })

  it('keeps the project header above the macOS drag region and opens new TODO', async () => {
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={services()}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    expect(screen.getByTestId('cloud-project-header')).toHaveClass('relative', 'z-10')
    await userEvent.click(screen.getByTestId('cloud-todo-add'))

    expect(screen.getByTestId('cloud-todo-title')).toBeInTheDocument()
    expect(screen.getAllByText('新建任务').length).toBeGreaterThan(1)
  })

  it('selects a parent while creating and exposes only one create action', async () => {
    const workbenchServices = services()
    const parent = { ...item, id: 'WEG-2', sequence_number: 2, title: 'Release' }
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({ items: [item, parent] }))
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      id: 'WEG-3',
      title: values.title,
      parent_id: values.parent_id ?? null,
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-add'))
    await userEvent.selectOptions(screen.getByTestId('cloud-todo-create-parent'), 'WEG-2')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Child task')
    expect(screen.queryByText('创建并完成')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('cloud-todo-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Child task',
        description: '',
        priority: 'none',
        status: 'inbox',
        parent_id: 'WEG-2',
      })
    )
  })

  it('edits TODO metadata without changing historical deliveries', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
    await userEvent.clear(screen.getByTestId('cloud-todo-detail-title'))
    await userEvent.type(screen.getByTestId('cloud-todo-detail-title'), 'Updated TODO')
    await userEvent.click(screen.getByTestId('cloud-todo-save'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.updateLoopItem).toHaveBeenCalledWith('WEG-1', {
        version: 1,
        title: 'Updated TODO',
        description: 'Use the shared workspace',
        parent_id: null,
        priority: 'high',
        status: 'in_progress',
        assignee_user_id: null,
        due_at: null,
      })
    )
    expect((await screen.findAllByText('Updated TODO')).length).toBeGreaterThan(0)
  })

  it('offers a follow-up task for a completed TODO', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'completed' as const }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))

    expect(screen.getByTestId('cloud-todo-start-task')).toHaveTextContent('开启后续任务')
    expect(screen.getByTestId('cloud-todo-detail-title')).toBeEnabled()
  })

  it('offers every board status when editing a completed TODO', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.listLoopItems = vi.fn(async () => ({
      items: [{ ...item, status: 'completed' as const }],
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(await screen.findByTestId('cloud-todo-card-WEG-1'))
    const status = screen.getByTestId('cloud-todo-detail-status')
    expect(status).toHaveValue('completed')
    expect(status.querySelectorAll('option')).toHaveLength(5)
    expect(status).toHaveTextContent('已完成')
    expect(status).toHaveTextContent('进行中')
    expect(status).toHaveTextContent('收集箱')
  })

  it('defaults new TODOs to the inbox unless another status is selected', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-add'))
    expect(screen.getByTestId('cloud-todo-create-status')).toHaveValue('inbox')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Inbox TODO')
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Inbox TODO',
        description: '',
        priority: 'none',
        status: 'inbox',
      })
    )
  })

  it('prefills a new TODO with its board column status and allows changing it', async () => {
    const workbenchServices = services()
    workbenchServices.deliveryApi!.createLoopItem = vi.fn(async (_projectId, values) => ({
      ...item,
      title: values.title,
      description: values.description ?? '',
      status: values.status ?? 'inbox',
    }))
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByTestId('cloud-todo-column-add-in_progress'))
    const status = screen.getByTestId('cloud-todo-create-status')
    expect(status).toHaveValue('in_progress')

    await userEvent.selectOptions(status, 'pending')
    await userEvent.type(screen.getByTestId('cloud-todo-title'), 'Pending TODO')
    await userEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createLoopItem).toHaveBeenCalledWith(11, {
        title: 'Pending TODO',
        description: '',
        priority: 'none',
        status: 'pending',
      })
    )
  })

  it('adds a create-work-item action to every board column', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    for (const state of ['inbox', 'pending', 'in_progress', 'in_review', 'completed']) {
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).toHaveClass(
        'overflow-y-auto',
        'overscroll-contain',
        'px-2',
        'pt-2'
      )
      expect(screen.getByTestId(`cloud-todo-column-dropzone-${state}`)).not.toHaveClass('p-2')
      expect(screen.getByTestId(`cloud-todo-column-bottom-add-${state}`)).toBeVisible()
      expect(screen.getByTestId(`cloud-todo-column-bottom-add-${state}`)).toHaveClass(
        'sticky',
        'bottom-0'
      )
    }

    await userEvent.click(screen.getByTestId('cloud-todo-column-bottom-add-completed'))
    expect(screen.getByTestId('cloud-todo-create-status')).toHaveValue('completed')
  })

  it('uses pointer dragging for TODO cards without starting a native system drag', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )
    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    const card = await screen.findByTestId('cloud-todo-card-WEG-1')
    expect(card).not.toHaveAttribute('draggable')
  })

  it('creates a shared cloud folder from the files view', async () => {
    const workbenchServices = services()
    render(
      <CloudTodoWorkspace
        user={{ id: 1, user_name: 'local', email: 'local@example.com' } as User}
        localProjects={[]}
        services={workbenchServices}
      />
    )

    await userEvent.click((await screen.findAllByText('Wegent V4'))[0])
    await userEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(
      screen.getByTestId('cloud-project-header').querySelector('[data-tauri-drag-region]')
    ).toBeInTheDocument()
    await userEvent.click(await screen.findByTestId('cloud-folder-add'))
    await userEvent.type(screen.getByTestId('cloud-folder-name'), 'docs')
    await userEvent.click(screen.getByTestId('cloud-folder-create-confirm'))

    await waitFor(() =>
      expect(workbenchServices.deliveryApi?.createCloudFolder).toHaveBeenCalledWith(11, 'docs')
    )
  })
})
